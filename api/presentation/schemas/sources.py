from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Annotated

from pydantic import AfterValidator, Field

from api.domain.models import File as FileDomain
from api.domain.models import Source as SourceDomain
from api.domain.models import SourceStatus, SourceType
from api.presentation.schemas.common import BaseSchema

# A citation year a source might reasonably carry - four digits, and not
# absurdly far in the past or future. `SourceCreate`/`SourceUpdate` used to
# accept any string here (`year="banana"` included) with no validation at
# all (issue #61).
_MIN_YEAR = 1000
_MAX_YEAR_SLACK = 1  # allow next calendar year (forthcoming publications)


def _require_plausible_year(value: str) -> str:
    year = int(value)
    max_year = datetime.now(timezone.utc).year + _MAX_YEAR_SLACK
    if not (_MIN_YEAR <= year <= max_year):
        raise ValueError(f"must be between {_MIN_YEAR} and {max_year}")
    return value


SourceYear = Annotated[str, Field(pattern=r"^\d{4}$"), AfterValidator(_require_plausible_year)]


class SourceCreate(BaseSchema):
    file_id: uuid.UUID
    type: SourceType | None = None
    authors: str | None = None
    year: SourceYear | None = None
    doi: str | None = None
    url: str | None = None
    description: str | None = None


class SourceUpdate(BaseSchema):
    type: SourceType | None = None
    authors: str | None = None
    year: SourceYear | None = None
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
