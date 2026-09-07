from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from api.domain.models import Source
from api.infrastructure.db.models import SourceRecord


def _as_aware_utc(value: datetime | None) -> datetime | None:
    # All timestamps are written in UTC; SQLite (unlike Postgres) drops the
    # tzinfo on round-trip, so re-attach it for consistent serialization.
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _to_domain(record: SourceRecord) -> Source:
    return Source(
        id=record.id,
        project_id=record.project_id,
        file_id=record.file_id,
        source_type=record.source_type,
        authors=record.authors,
        year=record.year,
        doi=record.doi,
        url=record.url,
        description=record.description,
        chunks_count=record.chunks_count,
        status=record.status,
        created_at=_as_aware_utc(record.created_at),
        deleted_at=_as_aware_utc(record.deleted_at),
    )


class SqlAlchemySourceRepository:
    """Sources are soft-deleted (`deleted_at`): `get`, `get_by_project_and_file`,
    `list`, and `list_all` only ever see active (non-deleted) rows, so a removed
    source disappears from the API and its file becomes re-attachable/deletable
    again. `update` is also how a removal is persisted (it sets `deleted_at`)."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, source: Source) -> Source:
        record = SourceRecord(
            id=source.id,
            project_id=source.project_id,
            file_id=source.file_id,
            source_type=source.source_type,
            authors=source.authors,
            year=source.year,
            doi=source.doi,
            url=source.url,
            description=source.description,
            chunks_count=source.chunks_count,
            status=source.status,
            created_at=source.created_at,
            deleted_at=source.deleted_at,
        )
        self._session.add(record)
        await self._session.commit()
        await self._session.refresh(record)
        return _to_domain(record)

    async def get(self, project_id: uuid.UUID, source_id: uuid.UUID) -> Source | None:
        record = await self._session.scalar(
            select(SourceRecord).where(
                SourceRecord.id == source_id,
                SourceRecord.project_id == project_id,
                SourceRecord.deleted_at.is_(None),
            )
        )
        return _to_domain(record) if record is not None else None

    async def get_by_project_and_file(
        self, project_id: uuid.UUID, file_id: uuid.UUID
    ) -> Source | None:
        record = await self._session.scalar(
            select(SourceRecord).where(
                SourceRecord.project_id == project_id,
                SourceRecord.file_id == file_id,
                SourceRecord.deleted_at.is_(None),
            )
        )
        return _to_domain(record) if record is not None else None

    async def list(
        self, project_id: uuid.UUID, limit: int, offset: int
    ) -> tuple[list[Source], int]:
        total = await self._session.scalar(
            select(func.count())
            .select_from(SourceRecord)
            .where(SourceRecord.project_id == project_id, SourceRecord.deleted_at.is_(None))
        )
        result = await self._session.execute(
            select(SourceRecord)
            .where(SourceRecord.project_id == project_id, SourceRecord.deleted_at.is_(None))
            .order_by(SourceRecord.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        records = result.scalars().all()
        return [_to_domain(record) for record in records], total or 0

    async def list_all(self, project_id: uuid.UUID) -> list[Source]:
        result = await self._session.execute(
            select(SourceRecord)
            .where(SourceRecord.project_id == project_id, SourceRecord.deleted_at.is_(None))
            .order_by(SourceRecord.created_at.desc())
        )
        return [_to_domain(record) for record in result.scalars().all()]

    async def update(self, source: Source) -> Source:
        record = await self._session.get(SourceRecord, source.id)
        assert record is not None
        record.authors = source.authors
        record.year = source.year
        record.doi = source.doi
        record.url = source.url
        record.description = source.description
        record.chunks_count = source.chunks_count
        record.status = source.status
        record.deleted_at = source.deleted_at
        await self._session.commit()
        return _to_domain(record)
