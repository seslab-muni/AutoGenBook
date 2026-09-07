from __future__ import annotations

import uuid
from collections.abc import Sequence

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from api.domain.models import File
from api.infrastructure.db.models import RunArtifactRecord, SourceRecord


class SqlAlchemyFileRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, file: File) -> None:
        self._session.add(file)
        await self._session.commit()
        await self._session.refresh(file)

    async def get(self, file_id: uuid.UUID) -> File | None:
        return await self._session.get(File, file_id)

    async def list(self, limit: int, offset: int) -> tuple[Sequence[File], int]:
        total = await self._session.scalar(select(func.count()).select_from(File))
        rows = await self._session.scalars(
            select(File).order_by(File.created_at.desc()).limit(limit).offset(offset)
        )
        return rows.all(), total or 0

    async def delete(self, file: File) -> None:
        await self._session.delete(file)
        await self._session.commit()

    async def is_referenced(self, file_id: uuid.UUID) -> bool:
        # A soft-deleted source row (`deleted_at` set) no longer counts as a
        # reference, so the file becomes deletable again once removed. Run
        # artifacts are never soft-deleted - a run's artifact rows only
        # disappear via `RunArtifactRepository.delete_by_run` (re-upload) or
        # the `runs` cascade (run deletion), both of which already remove
        # the reference before the file itself could be deleted.
        result = await self._session.scalar(
            select(SourceRecord.id)
            .where(SourceRecord.file_id == file_id, SourceRecord.deleted_at.is_(None))
            .limit(1)
        )
        if result is not None:
            return True
        result = await self._session.scalar(
            select(RunArtifactRecord.id)
            .where(RunArtifactRecord.file_id == file_id)
            .limit(1)
        )
        return result is not None
