from __future__ import annotations

import enum
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

from sqlalchemy import Boolean, CHAR, BigInteger, DateTime, Enum as SqlEnum, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from api.core.db import Base


class TargetAudience(str, enum.Enum):
    UNDERGRADUATE = "undergraduate"
    GRADUATE = "graduate"
    PHD_RESEARCHER = "phd_researcher"
    INDUSTRY_PRACTITIONER = "industry_practitioner"


class OutputFormat(str, enum.Enum):
    MARKDOWN = "markdown"
    LATEX = "latex"
    PDF = "pdf"


@dataclass
class Project:
    id: uuid.UUID
    owner_id: uuid.UUID | None
    title: str
    subtitle: str
    authors: list[str]
    topic: str
    target_audience: TargetAudience
    total_pages_budget: int
    equation_frequency_level: int
    do_consider_outline: bool
    do_consider_previous_sections: bool
    output_format: OutputFormat
    max_outline_levels: int
    additional_requirements: str | None
    last_run_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


@dataclass
class ProjectSummary:
    id: uuid.UUID
    title: str
    subtitle: str
    authors: list[str]
    topic: str
    target_audience: TargetAudience
    total_pages_budget: int
    sources_count: int
    outline_node_count: int
    last_run_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


class FileKind(str, enum.Enum):
    upload = "upload"
    artifact = "artifact"


class File(Base):
    __tablename__ = "files"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    storage_key: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    filename: Mapped[str] = mapped_column(String, nullable=False)
    content_type: Mapped[str] = mapped_column(String, nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False, index=True)
    kind: Mapped[FileKind] = mapped_column(
        SqlEnum(FileKind, name="file_kind", native_enum=True), nullable=False
    )
    kb_eligible: Mapped[bool] = mapped_column(Boolean, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )


@dataclass
class RunOptions:
    """Generation options for one book-mode CLI run.

    This is the API's own vocabulary for "how to run the CLI" — it is
    translated into concrete `main.py` flags in exactly one place,
    `api/infrastructure/cli/book_command.py:build_command`. Nothing outside
    that module should know or care what the underlying CLI flags are.
    """

    outline: Literal["project", "generate"]
    output_format: Literal["markdown", "latex", "pdf"] = "markdown"
    allow_subdivision: bool = True
    enable_web_rag: bool = False
    audit_book: bool = False
    audit_book_mode: Literal["off", "warn", "strict"] = "warn"
    legacy_tex: bool = False
    rebuild_kb: bool = False
    fail_fast_schema: bool = False
    resume: bool = False
    # Re-run that only re-exports TeX/PDF from already-generated Markdown,
    # without regenerating section content. Modeled now for issue #11; the
    # CLI adapter does not implement it yet.
    export_tex_only: bool = False


@dataclass
class RunEvent:
    """One structured progress event parsed out of a CLI subprocess run."""

    seq: int
    ts: datetime
    level: str
    stage: str
    message: str
    payload: dict[str, Any] | None = None
