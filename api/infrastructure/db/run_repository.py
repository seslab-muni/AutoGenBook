from __future__ import annotations

import dataclasses
import uuid
from collections.abc import Sequence
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from api.core.errors import Conflict
from api.domain.models import Run, RunEvent, RunOptions, RunStatus
from api.infrastructure.db.models import RunEventRecord, RunRecord

_ACTIVE_STATUSES = (RunStatus.queued, RunStatus.running)
_TERMINAL_STATUSES = (RunStatus.succeeded, RunStatus.failed, RunStatus.cancelled)


def _as_aware_utc(value: datetime | None) -> datetime | None:
    # SQLite drops tzinfo on round-trip (unlike Postgres); re-attach it.
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def run_to_domain(record: RunRecord) -> Run:
    return Run(
        id=record.id,
        project_id=record.project_id,
        kind=record.kind,
        status=record.status,
        options=RunOptions(**record.options),
        base_run_id=record.base_run_id,
        target_node_id=record.target_node_id,
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
    )


def _apply_domain_to_record(run: Run, record: RunRecord) -> None:
    record.project_id = run.project_id
    record.kind = run.kind
    record.status = run.status
    record.options = dataclasses.asdict(run.options)
    record.base_run_id = run.base_run_id
    record.target_node_id = run.target_node_id
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


class SqlAlchemyRunRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get(self, run_id: uuid.UUID) -> Run | None:
        record = await self._session.get(RunRecord, run_id)
        return run_to_domain(record) if record is not None else None

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
            select(RunRecord)
            .where(RunRecord.project_id == project_id)
            .order_by(RunRecord.queued_at.desc())
            .limit(limit)
            .offset(offset)
        )
        return [run_to_domain(record) for record in result.scalars().all()], total or 0

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
        return run_to_domain(record)

    async def update(self, run: Run) -> Run:
        record = await self._session.get(RunRecord, run.id)
        assert record is not None
        _apply_domain_to_record(run, record)
        await self._session.commit()
        await self._session.refresh(record)
        return run_to_domain(record)

    async def list_terminal_before(self, cutoff: datetime) -> list[Run]:
        result = await self._session.execute(
            select(RunRecord).where(
                RunRecord.status.in_(_TERMINAL_STATUSES),
                RunRecord.finished_at.is_not(None),
                RunRecord.finished_at < cutoff,
            )
        )
        return [run_to_domain(record) for record in result.scalars().all()]


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

    async def max_seq(self, run_id: uuid.UUID) -> int:
        value = await self._session.scalar(
            select(func.max(RunEventRecord.seq)).where(RunEventRecord.run_id == run_id)
        )
        return value or 0
