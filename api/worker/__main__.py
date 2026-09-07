from __future__ import annotations

import asyncio
import logging
import os
import signal
import socket

from api.application.runs import GenerationService, sweep_stale_work_dirs
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


async def _claim_and_execute(session_factory, storage, settings, worker_id: str) -> bool:
    """Claim one queued run (if any) and drive it to completion. Each call
    opens its own session/repositories, scoped to just this run - a run's
    DB work happens on one connection, held for as long as `execute` takes
    (potentially the whole CLI run), never shared across concurrent slots."""
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
        )
        try:
            finished = await service.execute(run)
            logger.info("run %s finished: status=%s exit_code=%s", finished.id, finished.status.value, finished.exit_code)
        except Exception:  # noqa: BLE001 - keep the slot alive for the next run
            logger.exception("run %s raised an unhandled error", run.id)
    return True


async def _worker_slot(slot: int, session_factory, storage, settings, stop_event: asyncio.Event) -> None:
    worker_id = f"{WORKER_ID}:{slot}"
    while not stop_event.is_set():
        try:
            claimed = await _claim_and_execute(session_factory, storage, settings, worker_id)
        except Exception:  # noqa: BLE001 - a claim/DB hiccup shouldn't kill the slot
            logger.exception("worker slot %s: error while polling/claiming", slot)
            claimed = False

        # Only one slot needs to sweep for stale runs / old work dirs each cycle.
        if slot == 0 and not claimed:
            try:
                async with session_factory() as session:
                    requeued = await SqlAlchemyRunQueue(session).requeue_stale(settings.worker_stale_s)
                if requeued:
                    logger.info("requeued %s stale run(s)", requeued)
            except Exception:  # noqa: BLE001
                logger.exception("worker slot %s: error while requeuing stale runs", slot)

            try:
                async with session_factory() as session:
                    removed = await sweep_stale_work_dirs(
                        SqlAlchemyRunRepository(session), settings.runs_retention_days
                    )
                if removed:
                    logger.info("removed %s stale work dir(s)", removed)
            except Exception:  # noqa: BLE001
                logger.exception("worker slot %s: error while sweeping stale work dirs", slot)

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
