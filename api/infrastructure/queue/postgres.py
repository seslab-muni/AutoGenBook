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

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from api.domain.models import Run, RunStatus
from api.infrastructure.db.models import RunRecord
from api.infrastructure.db.run_repository import run_to_domain

_ACTIVE_STATUSES = (RunStatus.queued, RunStatus.running)


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

    async def heartbeat(self, run_id: uuid.UUID) -> None:
        await self._session.execute(
            update(RunRecord)
            .where(RunRecord.id == run_id)
            .values(heartbeat_at=datetime.now(timezone.utc))
        )
        await self._session.commit()

    async def release(self, run_id: uuid.UUID) -> None:
        """Hand a claimed-but-not-finished run back to the queue (e.g. a
        worker shutting down mid-run)."""
        await self._session.execute(
            update(RunRecord)
            .where(RunRecord.id == run_id, RunRecord.status == RunStatus.running)
            .values(
                status=RunStatus.queued,
                locked_by=None,
                started_at=None,
                heartbeat_at=None,
            )
        )
        await self._session.commit()

    async def requeue_stale(self, older_than_s: float) -> int:
        """Requeue `running` rows whose `heartbeat_at` is older than
        `older_than_s` seconds - recovers runs orphaned by a worker that
        crashed or was killed without a chance to call `release`."""
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=older_than_s)
        result = await self._session.execute(
            update(RunRecord)
            .where(RunRecord.status == RunStatus.running, RunRecord.heartbeat_at < cutoff)
            .values(
                status=RunStatus.queued,
                locked_by=None,
                started_at=None,
                heartbeat_at=None,
            )
        )
        await self._session.commit()
        return result.rowcount or 0
