from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.core.db import get_session
from api.core.errors import StorageError
from api.domain.ports import FileStorage
from api.presentation.deps import get_file_storage

router = APIRouter(tags=["system"])


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/ready")
async def ready(
    session: AsyncSession = Depends(get_session),
    storage: FileStorage = Depends(get_file_storage),
) -> dict[str, str]:
    try:
        await session.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001 - any DB failure means "not ready"
        raise StorageError("database is not reachable") from exc
    await storage.healthcheck()
    return {"status": "ready"}
