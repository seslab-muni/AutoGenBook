from __future__ import annotations

import uuid
from collections.abc import Sequence

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from api.domain.models import File, FileKind
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

    async def get_many(self, file_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, File]:
        """Batch equivalent of `get`, one `SELECT ... WHERE id IN (...)`
        instead of a query per id - used by callers that otherwise looped
        `get()` per row (`SourceService.list`/`list_for_embed`,
        `RunService.artifacts`), which turned every `GET/POST/PATCH
        /projects/{id}` and `GET /runs/{id}/artifacts` into one statement
        per source/artifact (issue #51)."""
        ids = list(dict.fromkeys(file_ids))
        if not ids:
            return {}
        rows = await self._session.scalars(select(File).where(File.id.in_(ids)))
        return {file.id: file for file in rows.all()}

    async def list(
        self, limit: int, offset: int, *, kind: FileKind | None = None
    ) -> tuple[Sequence[File], int]:
        # `kind` lets the upload picker (`GET /files?kind=upload`) exclude
        # run artifacts from the same listing without a separate endpoint
        # (issue #61) - `None` (the default) keeps the previous unfiltered
        # behavior.
        count_query = select(func.count()).select_from(File)
        list_query = select(File).order_by(File.created_at.desc()).limit(limit).offset(offset)
        if kind is not None:
            count_query = count_query.where(File.kind == kind)
            list_query = list_query.where(File.kind == kind)
        total = await self._session.scalar(count_query)
        rows = await self._session.scalars(list_query)
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
