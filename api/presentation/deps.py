from __future__ import annotations

from functools import lru_cache

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from api.application.files import FileService
from api.application.outline import OutlineService
from api.application.runs import RunService
from api.core.db import get_session
from api.core.settings import Settings, get_settings
from api.domain.ports import FileStorage
from api.infrastructure.db.file_repository import SqlAlchemyFileRepository
from api.infrastructure.db.outline_repository import SqlAlchemyOutlineRepository
from api.infrastructure.db.repositories import SqlAlchemyProjectRepository
from api.infrastructure.db.run_artifact_repository import SqlAlchemyRunArtifactRepository
from api.infrastructure.db.run_repository import (
    SqlAlchemyRunEventRepository,
    SqlAlchemyRunRepository,
)
from api.infrastructure.storage.s3 import S3FileStorage


@lru_cache
def get_file_storage() -> FileStorage:
    return S3FileStorage(get_settings())


def get_file_service(
    session: AsyncSession = Depends(get_session),
    storage: FileStorage = Depends(get_file_storage),
    settings: Settings = Depends(get_settings),
) -> FileService:
    repository = SqlAlchemyFileRepository(session)
    return FileService(repository=repository, storage=storage, settings=settings)


def get_outline_service(session: AsyncSession = Depends(get_session)) -> OutlineService:
    return OutlineService(
        outline_repository=SqlAlchemyOutlineRepository(session),
        project_repository=SqlAlchemyProjectRepository(session),
    )


def get_run_service(
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> RunService:
    return RunService(
        run_repository=SqlAlchemyRunRepository(session),
        run_event_repository=SqlAlchemyRunEventRepository(session),
        project_repository=SqlAlchemyProjectRepository(session),
        run_artifact_repository=SqlAlchemyRunArtifactRepository(session),
        file_repository=SqlAlchemyFileRepository(session),
        settings=settings,
    )
