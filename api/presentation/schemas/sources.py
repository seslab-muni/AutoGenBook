from __future__ import annotations

import uuid
from datetime import datetime

from api.domain.models import File as FileDomain
from api.domain.models import Source as SourceDomain
from api.domain.models import SourceStatus, SourceType
from api.presentation.schemas.common import BaseSchema


class SourceCreate(BaseSchema):
    file_id: uuid.UUID
    type: SourceType | None = None
    authors: str | None = None
    year: str | None = None
    doi: str | None = None
    url: str | None = None
    description: str | None = None


class SourceUpdate(BaseSchema):
    authors: str | None = None
    year: str | None = None
    doi: str | None = None
    url: str | None = None
    description: str | None = None


class Source(BaseSchema):
    id: uuid.UUID
    file_id: uuid.UUID
    name: str
    size_bytes: int
    type: SourceType
    chunks_count: int | None = None
    status: SourceStatus
    upload_date: datetime
    authors: str | None = None
    year: str | None = None
    doi: str | None = None
    url: str | None = None
    description: str | None = None


def source_to_schema(source: SourceDomain, file: FileDomain) -> Source:
    return Source(
        id=source.id,
        file_id=source.file_id,
        name=file.filename,
        size_bytes=file.size_bytes,
        type=source.source_type,
        chunks_count=source.chunks_count,
        status=source.status,
        upload_date=file.created_at,
        authors=source.authors,
        year=source.year,
        doi=source.doi,
        url=source.url,
        description=source.description,
    )
