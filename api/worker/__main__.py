from __future__ import annotations

import asyncio
import logging

from api.core.settings import get_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("api.worker")


async def _poll_once() -> None:
    # Job queue polling lands in a later issue; for now the loop only proves
    # the worker process stays up and is wired to its settings/DB config.
    logger.info("polling for runs (queue not wired up yet)")


async def main() -> None:
    settings = get_settings()
    logger.info(
        "worker starting: concurrency=%s poll_interval=%ss",
        settings.worker_concurrency,
        settings.worker_poll_interval_s,
    )
    while True:
        await _poll_once()
        await asyncio.sleep(settings.worker_poll_interval_s)


if __name__ == "__main__":
    asyncio.run(main())
