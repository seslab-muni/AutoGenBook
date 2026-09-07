from __future__ import annotations

import enum
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

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


class NodeStatus(str, enum.Enum):
    NOT_STARTED = "not_started"
    DRAFTING = "drafting"
    REVIEW_READY = "review_ready"
    COMPILED = "compiled"


class MathLevel(str, enum.Enum):
    INTRODUCTORY = "introductory"
    RIGOROUS = "rigorous"
    FORMAL_PROOF = "formal_proof"
    APPLIED = "applied"


@dataclass
class OutlineNode:
    id: uuid.UUID
    project_id: uuid.UUID
    parent_id: uuid.UUID | None
    order_index: int
    title: str
    summary: str
    status: NodeStatus
    target_pages: float
    word_budget: int
    actual_words: int
    equation_density_level: int
    math_level: MathLevel
    sub_prompt: str | None
    content_markdown: str
    content_latex: str
    rag_citations: list[dict]
    reviewer_score: float | None
    reviewer_notes: str | None
    structure_locked: bool
    created_at: datetime
    updated_at: datetime
    # Soft delete: set (recursively, for the whole subtree) instead of a SQL
    # DELETE by `OutlineRepository.delete_subtree`. NULL = live; repository
    # reads filter it out by default, so a service/schema never needs to
    # check it directly.
    deleted_at: datetime | None = None
    # Server-derived, never persisted as-is on their own (`cli_key` is a real
    # column recomputed on every structural change; `level`/`section_number`
    # are never stored at all) - populated by
    # `api.domain.outline.assign_positions` before a node reaches a schema.
    cli_key: str | None = None
    level: int = 0
    section_number: str = ""


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
