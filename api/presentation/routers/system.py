from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.application.system import SystemService
from api.core.db import get_session
from api.core.errors import StorageError
from api.domain.ports import FileStorage
from api.presentation.deps import get_file_storage, get_system_service
from api.presentation.schemas.system import ModelList, model_list_to_schema

# Public: no auth required (mounted under `api.main`'s `public_router`, alongside login) -
# `health`/`ready` are liveness/readiness probes hit by the Compose healthcheck and Kubernetes,
# neither of which authenticates.
router = APIRouter(tags=["system"])

# Guarded (mounted under `api.main`'s `guarded_router`, same as every other resource route):
# unlike `health`/`ready`, `GET /system/models` reaches out to the deployment's own configured
# LLM endpoint and is only useful to an already-authenticated user picking a model.
guarded_router = APIRouter(tags=["system"])


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


@guarded_router.get("/system/models", response_model=ModelList)
async def list_models(service: SystemService = Depends(get_system_service)) -> ModelList:
    return model_list_to_schema(await service.list_models())
