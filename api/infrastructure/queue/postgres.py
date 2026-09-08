"""Postgres-backed `RunQueue`: `claim` atomically hands one queued run to a
worker via `SELECT ... FOR UPDATE SKIP LOCKED`, so multiple `worker`
containers can poll the same `runs` table without double-claiming a row or
blocking each other on locked-but-uninteresting rows.

`FOR UPDATE SKIP LOCKED` is Postgres-only; the sqlite test suite (`api`'s
unit tests run against `sqlite+aiosqlite://`, see `tests/api/conftest.py`)
has no row locking at all, so `claim` only applies it when the bound engine
actually is Postgres. The `WHERE status = 'queued'` re-check on the UPDATE
still makes a claim safe even without the lock (just not safe under real
concurrency, which is why the two-worker race test requires Postgres).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from api.domain.models import Run, RunKind, RunStatus
from api.infrastructure.cli.book_command import OUT_DIRNAME
from api.infrastructure.db.models import RunRecord
from api.infrastructure.db.run_repository import run_to_domain

_ACTIVE_STATUSES = (RunStatus.queued, RunStatus.running)
_STRUCTURE_GRAPH_FILENAME = "structure_graph.json"


def _dialect_name(session: AsyncSession) -> str:
    bind = session.bind
    dialect = getattr(bind, "dialect", None)
    return dialect.name if dialect is not None else "postgresql"


class SqlAlchemyRunQueue:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def claim(self, worker_id: str) -> Run | None:
        candidate_stmt = (
            select(RunRecord.id)
            .where(RunRecord.status == RunStatus.queued)
            .order_by(RunRecord.queued_at)
            .limit(1)
        )
        if _dialect_name(self._session) == "postgresql":
            candidate_stmt = candidate_stmt.with_for_update(skip_locked=True)

        candidate_id = await self._session.scalar(candidate_stmt)
        if candidate_id is None:
            return None

        now = datetime.now(timezone.utc)
        result = await self._session.execute(
            update(RunRecord)
            .where(RunRecord.id == candidate_id, RunRecord.status == RunStatus.queued)
            .values(
                status=RunStatus.running,
                locked_by=worker_id,
                started_at=now,
                heartbeat_at=now,
            )
        )
        await self._session.commit()
        if result.rowcount == 0:
            # Lost the race to another worker between the SELECT and UPDATE
            # (only possible without SKIP LOCKED, i.e. on sqlite in tests).
            return None

        record = await self._session.get(RunRecord, candidate_id)
        assert record is not None
        return run_to_domain(record)

    async def heartbeat(self, run_id: uuid.UUID, worker_id: str | None = None) -> bool:
        """Refresh `heartbeat_at`, but only while the row is still `running`
        and (when `worker_id` is given) still locked by that worker - a
        compare-and-set rather than an unconditional write, so a worker that
        `requeue_stale` already reassigned to someone else notices (via the
        `False` return) and stops instead of continuing to "renew" a lease
        it no longer holds (issue #52). `worker_id` is optional only so
        callers that don't track a lease at all (tests driving
        `GenerationService` directly against an unclaimed run) keep their
        previous unconditional-while-running behavior."""
        conditions = [RunRecord.id == run_id, RunRecord.status == RunStatus.running]
        if worker_id is not None:
            conditions.append(RunRecord.locked_by == worker_id)
        result = await self._session.execute(
            update(RunRecord)
            .where(*conditions)
            .values(heartbeat_at=datetime.now(timezone.utc))
        )
        await self._session.commit()
        return (result.rowcount or 0) > 0

    async def release(
        self,
        run_id: uuid.UUID,
        worker_id: str | None = None,
        *,
        options: dict[str, Any] | None = None,
    ) -> bool:
        """Hand a claimed-but-not-finished run back to the queue (e.g. a
        worker shutting down mid-run, `GenerationService._release_for_
        shutdown`) - guarded the same way `heartbeat` is, by `worker_id`,
        so a worker that already lost its lease can't hand a *different*
        worker's in-progress run back to `queued` out from under it.
        `options`, if given, replaces the run's stored `RunOptions` (e.g.
        flipping `resume=True` before requeuing a `full` run whose work
        directory already has a `structure_graph.json`, so the retry
        doesn't regenerate every section from scratch)."""
        conditions = [RunRecord.id == run_id, RunRecord.status == RunStatus.running]
        if worker_id is not None:
            conditions.append(RunRecord.locked_by == worker_id)
        values: dict[str, Any] = dict(
            status=RunStatus.queued,
            locked_by=None,
            started_at=None,
            heartbeat_at=None,
        )
        if options is not None:
            values["options"] = options
        result = await self._session.execute(update(RunRecord).where(*conditions).values(**values))
        await self._session.commit()
        return (result.rowcount or 0) > 0

    async def requeue_stale(self, older_than_s: float) -> int:
        """Requeue `running` rows whose `heartbeat_at` is older than
        `older_than_s` seconds - recovers runs orphaned by a worker that
        crashed or was killed without a chance to call `release`.

        A requeued `full` run whose work directory already has a
        `structure_graph.json` (the CLI got far enough to at least
        structure the outline, possibly generate several sections) has its
        `options.resume` flipped to `True` before being handed to the next
        worker, so the retry resumes from what's already on disk instead of
        regenerating - and paying for - every section again (issue #52)."""
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=older_than_s)
        candidates = (
            await self._session.execute(
                select(RunRecord.id, RunRecord.kind, RunRecord.work_dir, RunRecord.options).where(
                    RunRecord.status == RunStatus.running, RunRecord.heartbeat_at < cutoff
                )
            )
        ).all()
        if not candidates:
            return 0

        result = await self._session.execute(
            update(RunRecord)
            .where(RunRecord.id.in_([row.id for row in candidates]))
            .values(
                status=RunStatus.queued,
                locked_by=None,
                started_at=None,
                heartbeat_at=None,
            )
        )
        requeued = result.rowcount or 0

        for row in candidates:
            if row.kind != RunKind.full or (row.options or {}).get("resume"):
                continue
            graph_path = Path(row.work_dir) / OUT_DIRNAME / _STRUCTURE_GRAPH_FILENAME
            if not await run_in_threadpool(graph_path.is_file):
                continue
            resumed_options = dict(row.options or {})
            resumed_options["resume"] = True
            await self._session.execute(
                update(RunRecord).where(RunRecord.id == row.id).values(options=resumed_options)
            )

        await self._session.commit()
        return requeued
