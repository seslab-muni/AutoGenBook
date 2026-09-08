from __future__ import annotations

import dataclasses
import uuid
from collections.abc import Sequence
from datetime import datetime, timezone

from sqlalchemy import case, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from api.core.errors import Conflict, NotFound
from api.domain.models import Run, RunEvent, RunOptions, RunStatus
from api.infrastructure.db.models import RunEventRecord, RunRecord, UserRecord

_ACTIVE_STATUSES = (RunStatus.queued, RunStatus.running)

_RUN_OPTIONS_FIELDS = {f.name for f in dataclasses.fields(RunOptions)}


def _as_aware_utc(value: datetime | None) -> datetime | None:
    # SQLite drops tzinfo on round-trip (unlike Postgres); re-attach it.
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _run_options_from_json(data: dict) -> RunOptions:
    """Tolerant `RunOptions` deserialization (issue #60): a stored `options`
    JSON blob is a snapshot from whatever `RunOptions` shape existed when the
    row was written. `RunOptions(**data)` would raise `TypeError` on any key
    the dataclass no longer has (a field removed/renamed since) and can never
    supply a value for a field added since - both would break every read of
    a pre-existing row (`GET /runs/...`, `GET /projects/{id}/runs`, the
    worker's `claim()`) until a data migration ran. Filtering to just the
    keys `RunOptions` currently declares drops unknown/removed keys silently
    and leaves any newly-added field to fall back to its own dataclass
    default instead."""
    return RunOptions(**{k: v for k, v in data.items() if k in _RUN_OPTIONS_FIELDS})


def run_to_domain(record: RunRecord, started_by_name: str | None = None) -> Run:
    return Run(
        id=record.id,
        project_id=record.project_id,
        kind=record.kind,
        status=record.status,
        options=_run_options_from_json(record.options),
        base_run_id=record.base_run_id,
        target_node_id=record.target_node_id,
        target_node_previous_status=record.target_node_previous_status,
        work_dir=record.work_dir,
        exit_code=record.exit_code,
        error=record.error,
        cancel_requested=record.cancel_requested,
        locked_by=record.locked_by,
        heartbeat_at=_as_aware_utc(record.heartbeat_at),
        queued_at=_as_aware_utc(record.queued_at),
        started_at=_as_aware_utc(record.started_at),
        finished_at=_as_aware_utc(record.finished_at),
        total_tokens=record.total_tokens,
        total_cost_usd=(
            float(record.total_cost_usd) if record.total_cost_usd is not None else None
        ),
        started_by=record.started_by,
        started_by_name=started_by_name,
    )


def _apply_domain_to_record(run: Run, record: RunRecord) -> None:
    record.project_id = run.project_id
    record.kind = run.kind
    record.status = run.status
    record.options = dataclasses.asdict(run.options)
    record.base_run_id = run.base_run_id
    record.target_node_id = run.target_node_id
    record.target_node_previous_status = run.target_node_previous_status
    record.work_dir = run.work_dir
    record.exit_code = run.exit_code
    record.error = run.error
    record.cancel_requested = run.cancel_requested
    record.locked_by = run.locked_by
    record.heartbeat_at = run.heartbeat_at
    record.queued_at = run.queued_at
    record.started_at = run.started_at
    record.finished_at = run.finished_at
    record.total_tokens = run.total_tokens
    record.total_cost_usd = run.total_cost_usd
    record.started_by = run.started_by


class SqlAlchemyRunRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get(self, run_id: uuid.UUID) -> Run | None:
        row = (
            await self._session.execute(
                select(RunRecord, UserRecord.display_name)
                .outerjoin(UserRecord, UserRecord.id == RunRecord.started_by)
                .where(RunRecord.id == run_id)
            )
        ).first()
        if row is None:
            return None
        record, started_by_name = row
        return run_to_domain(record, started_by_name)

    async def _started_by_name(self, started_by: uuid.UUID | None) -> str | None:
        if started_by is None:
            return None
        return await self._session.scalar(
            select(UserRecord.display_name).where(UserRecord.id == started_by)
        )

    async def get_active_for_project(self, project_id: uuid.UUID) -> Run | None:
        record = await self._session.scalar(
            select(RunRecord)
            .where(
                RunRecord.project_id == project_id,
                RunRecord.status.in_(_ACTIVE_STATUSES),
            )
            .order_by(RunRecord.queued_at.desc())
            .limit(1)
        )
        return run_to_domain(record) if record is not None else None

    async def list(
        self, project_id: uuid.UUID, limit: int, offset: int
    ) -> tuple[list[Run], int]:
        total = await self._session.scalar(
            select(func.count())
            .select_from(RunRecord)
            .where(RunRecord.project_id == project_id)
        )
        result = await self._session.execute(
            select(RunRecord, UserRecord.display_name)
            .outerjoin(UserRecord, UserRecord.id == RunRecord.started_by)
            .where(RunRecord.project_id == project_id)
            .order_by(RunRecord.queued_at.desc())
            .limit(limit)
            .offset(offset)
        )
        return [
            run_to_domain(record, started_by_name) for record, started_by_name in result.all()
        ], total or 0

    async def rollback(self) -> None:
        """Recover the shared session from a poisoned ("pending rollback")
        state after a failed commit elsewhere (e.g. `SqlAlchemyRunEventRepository
        .append_batch`), so subsequent writes on it (e.g. `update`, from
        `GenerationService._fail`/`_finalize`) don't also raise
        `PendingRollbackError`. Safe to call even when the session isn't
        poisoned."""
        await self._session.rollback()

    async def add(self, run: Run) -> Run:
        record = RunRecord(id=run.id)
        _apply_domain_to_record(run, record)
        self._session.add(record)
        try:
            await self._session.commit()
        except IntegrityError as exc:
            # `uq_runs_project_active` is the backstop for the
            # check-then-insert race in `RunService.create` (two concurrent
            # requests can both pass its `get_active_for_project` check
            # before either commits) - translate the resulting constraint
            # violation into the same `Conflict` that check itself raises.
            await self._session.rollback()
            raise Conflict(
                f"project {run.project_id} already has an active run"
            ) from exc
        await self._session.refresh(record)
        started_by_name = await self._started_by_name(record.started_by)
        return run_to_domain(record, started_by_name)

    async def update(self, run: Run) -> Run:
        record = await self._session.get(RunRecord, run.id)
        if record is None:
            # The row disappeared between the caller's read and this write
            # (e.g. a concurrent hard delete) - a proper `NotFound` (404)
            # instead of a bare `AssertionError` (a 500 that, under
            # `python -O`, disappears entirely and lets the next line raise
            # a confusing `AttributeError` instead; issue #62).
            raise NotFound(f"run {run.id} does not exist")
        _apply_domain_to_record(run, record)
        await self._session.commit()
        await self._session.refresh(record)
        started_by_name = await self._started_by_name(record.started_by)
        return run_to_domain(record, started_by_name)

    async def finalize(self, run: Run, *, expected_locked_by: str | None = None) -> Run | None:
        """Persist `run`'s terminal outcome (status/exit_code/error/
        cancel_requested/finished_at/totals), but only if the row is still
        `running` (and, when `expected_locked_by` is given, still locked by
        that worker) - a conditional `UPDATE ... WHERE ...` rather than
        `update()`'s blind full-row overwrite.

        Guards against two distinct lost-update races (issue #52/#56): a
        second worker that has since reclaimed this run after
        `requeue_stale` decided the first worker's heartbeat had gone stale
        (`expected_locked_by` no longer matches `locked_by`), and
        `RunService.cancel` committing a `running` -> `cancelled` transition
        in the narrow window between this worker reading `run` and writing
        its own outcome (`status` no longer `running`). Returns `None` when
        the condition didn't hold, so the caller knows its write was
        skipped rather than silently believing it won."""
        conditions = [RunRecord.id == run.id, RunRecord.status == RunStatus.running]
        if expected_locked_by is not None:
            conditions.append(RunRecord.locked_by == expected_locked_by)
        result = await self._session.execute(
            update(RunRecord)
            .where(*conditions)
            .values(
                status=run.status,
                exit_code=run.exit_code,
                error=run.error,
                cancel_requested=run.cancel_requested,
                finished_at=run.finished_at,
                total_tokens=run.total_tokens,
                total_cost_usd=run.total_cost_usd,
            )
        )
        await self._session.commit()
        if result.rowcount == 0:
            return None
        return await self._get_fresh(run.id)

    async def request_cancel(self, run_id: uuid.UUID) -> Run | None:
        """Set `cancel_requested` (and, for a run still `queued`, resolve it
        straight to `cancelled` since no worker has claimed it yet to do so
        itself) via a targeted `UPDATE`, never the full-row overwrite
        `RunService.cancel` used to do. That overwrite raced the worker's
        own `_finalize`/`_fail` committing a terminal status in the same
        narrow window and silently reverted it back to `running` with no
        worker attached (issue #56) - this only ever touches the specific
        column(s) each transition needs, guarded by the row's current
        `status`, so a run that has already finished by the time this
        commits is simply left alone."""
        now = datetime.now(timezone.utc)
        queued_result = await self._session.execute(
            update(RunRecord)
            .where(RunRecord.id == run_id, RunRecord.status == RunStatus.queued)
            .values(
                status=RunStatus.cancelled,
                cancel_requested=True,
                error="cancelled before it started",
                finished_at=now,
            )
        )
        if queued_result.rowcount == 0:
            # Not `queued` (already `running`, or already terminal) - only
            # ever flip the flag on a `running` row; a worker's own
            # `finalize` decides the actual terminal status.
            await self._session.execute(
                update(RunRecord)
                .where(RunRecord.id == run_id, RunRecord.status == RunStatus.running)
                .values(cancel_requested=True)
            )
        await self._session.commit()
        return await self._get_fresh(run_id)

    async def _get_fresh(self, run_id: uuid.UUID) -> Run | None:
        """Like `get`, but never trusts a copy already sitting in the
        session's identity map from an earlier `get()`/`add()` in the same
        request (e.g. `RunService.cancel`'s own initial read) - `finalize`/
        `request_cancel` write via a raw `UPDATE` Core statement, which
        (unlike the ORM-attribute writes `update()` does) never touches an
        already-loaded instance's in-memory attributes, so a plain `get()`
        right after committing one would silently hand back stale data."""
        record = await self._session.get(RunRecord, run_id)
        if record is None:
            return None
        await self._session.refresh(record)
        started_by_name = await self._started_by_name(record.started_by)
        return run_to_domain(record, started_by_name)

    async def list_stale_work_dirs(self, cutoff: datetime) -> list[str]:
        """`work_dir`s safe to `rmtree` for `sweep_stale_work_dirs`: a
        `regenerate_section`/`export` run reuses its base run's `work_dir`
        verbatim (`RunService.regenerate_node`/`export`), so sweeping by
        individual terminal-and-old runs (the previous `list_terminal_before`)
        could delete a directory a newer, still-`running` (or resumable)
        sibling run was still relying on. A `work_dir` only qualifies when
        *every* run that references it is terminal and none of them
        finished after `cutoff` - i.e. the whole group has been idle for
        `retention_days`, not just the run that happened to create the
        directory (issue #64)."""
        non_terminal_count = func.sum(
            case((RunRecord.status.in_(_ACTIVE_STATUSES), 1), else_=0)
        )
        result = await self._session.execute(
            select(RunRecord.work_dir)
            .group_by(RunRecord.work_dir)
            .having(non_terminal_count == 0)
            .having(func.max(RunRecord.finished_at) < cutoff)
        )
        return [row[0] for row in result.all()]

    async def list_all_work_dirs(self) -> list[str]:
        """Every `work_dir` any `runs` row references, regardless of status
        - used by `sweep_orphaned_work_dirs` (issue #57) to find directories
        under `RUNS_DIR` that no row references *at all* (e.g. a project
        hard-deleted before soft delete existed, which cascaded away every
        `runs` row for it and orphaned its work directory with nothing left
        in the database to ever find it by). Unlike `list_stale_work_dirs`,
        this doesn't filter by status or age - it's the full universe of
        "known" directories, not just ones safe to remove on their own."""
        result = await self._session.execute(select(RunRecord.work_dir).distinct())
        return [row[0] for row in result.all()]


def _event_to_domain(record: RunEventRecord) -> RunEvent:
    return RunEvent(
        seq=record.seq,
        ts=_as_aware_utc(record.ts),
        level=record.level,
        stage=record.stage,
        message=record.message,
        payload=record.payload,
    )


class SqlAlchemyRunEventRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def append_batch(self, run_id: uuid.UUID, events: Sequence[RunEvent]) -> None:
        if not events:
            return
        for event in events:
            self._session.add(
                RunEventRecord(
                    run_id=run_id,
                    seq=event.seq,
                    ts=event.ts,
                    level=event.level,
                    stage=event.stage,
                    message=event.message,
                    payload=event.payload,
                )
            )
        await self._session.commit()

    async def list(
        self, run_id: uuid.UUID, after_seq: int, limit: int
    ) -> tuple[list[RunEvent], int]:
        total = await self._session.scalar(
            select(func.count())
            .select_from(RunEventRecord)
            .where(RunEventRecord.run_id == run_id, RunEventRecord.seq > after_seq)
        )
        result = await self._session.execute(
            select(RunEventRecord)
            .where(RunEventRecord.run_id == run_id, RunEventRecord.seq > after_seq)
            .order_by(RunEventRecord.seq)
            .limit(limit)
        )
        return [_event_to_domain(record) for record in result.scalars().all()], total or 0

    async def list_after(
        self, run_id: uuid.UUID, after_seq: int, limit: int
    ) -> list[RunEvent]:
        """Like `list`, but skips the `count(*)` - for callers (SSE polling)
        that only need the next batch of events, not a total."""
        result = await self._session.execute(
            select(RunEventRecord)
            .where(RunEventRecord.run_id == run_id, RunEventRecord.seq > after_seq)
            .order_by(RunEventRecord.seq)
            .limit(limit)
        )
        return [_event_to_domain(record) for record in result.scalars().all()]

    async def max_seq(self, run_id: uuid.UUID) -> int:
        value = await self._session.scalar(
            select(func.max(RunEventRecord.seq)).where(RunEventRecord.run_id == run_id)
        )
        return value or 0
