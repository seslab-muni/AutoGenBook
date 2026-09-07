from __future__ import annotations

from functools import lru_cache

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from api.application.files import FileService
from api.core.db import get_session
from api.core.settings import Settings, get_settings
from api.domain.ports import FileStorage
from api.infrastructure.db.file_repository import SqlAlchemyFileRepository
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
