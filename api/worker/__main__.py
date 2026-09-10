from __future__ import annotations

import asyncio
import logging
import os
import signal
import socket

from sqlalchemy import text

from api.application.runs import GenerationService, sweep_orphaned_work_dirs, sweep_stale_work_dirs
from api.core.db import get_sessionmaker
from api.core.settings import get_settings
from api.infrastructure.db.file_repository import SqlAlchemyFileRepository
from api.infrastructure.db.outline_repository import SqlAlchemyOutlineRepository
from api.infrastructure.db.repositories import SqlAlchemyProjectRepository
from api.infrastructure.db.run_artifact_repository import SqlAlchemyRunArtifactRepository
from api.infrastructure.db.run_repository import (
    SqlAlchemyRunEventRepository,
    SqlAlchemyRunRepository,
)
from api.infrastructure.db.source_repository import SqlAlchemySourceRepository
from api.infrastructure.queue.postgres import SqlAlchemyRunQueue
from api.infrastructure.storage.s3 import S3FileStorage

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("api.worker")

WORKER_ID = f"{socket.gethostname()}:{os.getpid()}"

# Issue #134 phase 3: arbitrary constant `pg_try_advisory_lock`/`pg_advisory_
# unlock` key for the housekeeping sweep below - shared by every worker
# replica so at most one of them runs it per poll cycle. Session-scoped
# (not `_xact_`): `requeue_stale` commits internally, and an `_xact_` lock
# would release the moment that commit ends its transaction, leaving the
# two sweeps still to come unprotected. Picking a fixed literal risks a
# collision with `SqlAlchemyRunRepository.lock_project_for_admission`'s own
# `hashtext(project_id)` keys only astronomically rarely, and even then the
# worst case is one poll cycle's extra wait, never an incorrect result.
_SWEEP_ADVISORY_LOCK_KEY = 134_000_001


async def _claim_and_execute(
    session_factory, storage, settings, worker_id: str, stop_event: asyncio.Event | None = None
) -> bool:
    """Claim one queued run (if any) and drive it to completion. Each call
    opens its own session/repositories, scoped to just this run - a run's
    DB work happens on one connection, held for as long as `execute` takes
    (potentially the whole CLI run), never shared across concurrent slots.

    `stop_event`, when given, is passed through to `GenerationService.
    execute` as its `shutdown_event` - on SIGTERM, this lets a run already
    in flight have its CLI subprocess torn down and handed back to the
    queue right away instead of blocking `execute()` (and this whole slot)
    until it would otherwise finish, which used to leave the container
    running well past compose's `stop_grace_period` and get SIGKILLed with
    the run stuck `running` (issue #52)."""
    async with session_factory() as session:
        run = await SqlAlchemyRunQueue(session).claim(worker_id)
    if run is None:
        return False

    logger.info("claimed run %s (project %s)", run.id, run.project_id)
    async with session_factory() as session:
        service = GenerationService(
            run_repository=SqlAlchemyRunRepository(session),
            run_event_repository=SqlAlchemyRunEventRepository(session),
            run_queue=SqlAlchemyRunQueue(session),
            project_repository=SqlAlchemyProjectRepository(session),
            outline_repository=SqlAlchemyOutlineRepository(session),
            source_repository=SqlAlchemySourceRepository(session),
            file_repository=SqlAlchemyFileRepository(session),
            file_storage=storage,
            run_artifact_repository=SqlAlchemyRunArtifactRepository(session),
            settings=settings,
            worker_id=worker_id,
        )
        try:
            finished = await service.execute(run, shutdown_event=stop_event)
            logger.info("run %s finished: status=%s exit_code=%s", finished.id, finished.status.value, finished.exit_code)
        except Exception:  # noqa: BLE001 - keep the slot alive for the next run
            logger.exception("run %s raised an unhandled error", run.id)
    return True


def _dialect_name(session) -> str:
    bind = session.bind
    dialect = getattr(bind, "dialect", None)
    return dialect.name if dialect is not None else "postgresql"


async def _run_housekeeping_sweeps(slot: int, session_factory, settings) -> None:
    """Requeue stale runs and sweep stale/orphaned work directories - issue
    #134 phase 3: with `replicas: 5` (`WORKER_CONCURRENCY=1` each), every
    pod's own slot 0 used to run this every cycle, all five racing the same
    rows/directories. Each sweep already tolerates that on its own
    (`requeue_stale` is a guarded `UPDATE`, both `rmtree` calls pass
    `ignore_errors=True`), so this was wasted work, not a correctness bug -
    a session-scoped `pg_try_advisory_lock` (Postgres only; sqlite has no
    advisory locks and the test suite never drives this concurrently
    anyway) lets exactly one replica actually run the sweep per cycle; the
    rest see the lock held, skip this cycle, and try again next poll."""
    async with session_factory() as session:
        is_postgres = _dialect_name(session) == "postgresql"
        if is_postgres:
            acquired = await session.scalar(
                text("SELECT pg_try_advisory_lock(:key)"), {"key": _SWEEP_ADVISORY_LOCK_KEY}
            )
            if not acquired:
                return
        try:
            try:
                requeued = await SqlAlchemyRunQueue(session).requeue_stale(settings.worker_stale_s)
                if requeued:
                    logger.info("requeued %s stale run(s)", requeued)
            except Exception:  # noqa: BLE001
                logger.exception("worker slot %s: error while requeuing stale runs", slot)

            try:
                removed = await sweep_stale_work_dirs(
                    SqlAlchemyRunRepository(session), settings.runs_retention_days
                )
                if removed:
                    logger.info("removed %s stale work dir(s)", removed)
            except Exception:  # noqa: BLE001
                logger.exception("worker slot %s: error while sweeping stale work dirs", slot)

            try:
                orphaned = await sweep_orphaned_work_dirs(
                    SqlAlchemyRunRepository(session), settings.runs_dir
                )
                if orphaned:
                    logger.info("removed %s orphaned work dir(s)", orphaned)
            except Exception:  # noqa: BLE001
                logger.exception("worker slot %s: error while sweeping orphaned work dirs", slot)
        finally:
            if is_postgres:
                await session.execute(
                    text("SELECT pg_advisory_unlock(:key)"), {"key": _SWEEP_ADVISORY_LOCK_KEY}
                )
                await session.commit()


async def _worker_slot(slot: int, session_factory, storage, settings, stop_event: asyncio.Event) -> None:
    worker_id = f"{WORKER_ID}:{slot}"
    while not stop_event.is_set():
        try:
            claimed = await _claim_and_execute(session_factory, storage, settings, worker_id, stop_event)
        except Exception:  # noqa: BLE001 - a claim/DB hiccup shouldn't kill the slot
            logger.exception("worker slot %s: error while polling/claiming", slot)
            claimed = False

        # Only slot 0 of any given replica *attempts* the sweep - and, of
        # every replica's slot 0 attempting it, the advisory lock inside
        # `_run_housekeeping_sweeps` lets only one actually run it.
        if slot == 0 and not claimed:
            try:
                await _run_housekeeping_sweeps(slot, session_factory, settings)
            except Exception:  # noqa: BLE001 - a lock/DB hiccup shouldn't kill the slot
                logger.exception("worker slot %s: error while running housekeeping sweeps", slot)

        if not claimed and not stop_event.is_set():
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=settings.worker_poll_interval_s)
            except asyncio.TimeoutError:
                pass


async def main() -> None:
    settings = get_settings()
    logger.info(
        "worker starting: id=%s concurrency=%s poll_interval=%ss",
        WORKER_ID,
        settings.worker_concurrency,
        settings.worker_poll_interval_s,
    )

    session_factory = get_sessionmaker()
    storage = S3FileStorage(settings)

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:  # pragma: no cover - non-POSIX fallback
            pass

    slots = [
        _worker_slot(slot, session_factory, storage, settings, stop_event)
        for slot in range(max(1, settings.worker_concurrency))
    ]
    await asyncio.gather(*slots)
    logger.info("worker stopped")


if __name__ == "__main__":
    asyncio.run(main())
