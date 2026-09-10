from __future__ import annotations

import enum
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

from sqlalchemy import Boolean, CHAR, BigInteger, DateTime, Enum as SqlEnum, Text, Uuid
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
    # Issue #128: always a concrete model id, never `None` - `ProjectService.create`
    # initializes it from `AUTOGENBOOK_LLM_MODEL` (or `FALLBACK_LLM_MODEL`) when the caller
    # doesn't supply one, and the migration backfilling this column did the same for every
    # pre-existing row. `RunOptions.llm_model` falls back to this when a run doesn't override it.
    llm_model: str
    last_run_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    # Derived, never persisted on this row: `owner_id`'s matching
    # `users.display_name` at read time, joined in by the repository
    # (`SqlAlchemyProjectRepository`) rather than looked up per-row by a
    # service - `None` for a legacy project (`owner_id IS NULL`) or one
    # whose owner account no longer exists.
    owner_name: str | None = None


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
    owner_id: uuid.UUID | None = None
    owner_name: str | None = None


@dataclass
class User:
    id: uuid.UUID
    email: str
    display_name: str
    password_hash: str
    is_active: bool
    password_changed_at: datetime
    created_at: datetime
    updated_at: datetime


class SourceType(str, enum.Enum):
    pdf = "pdf"
    doc = "doc"
    ppt = "ppt"
    md = "md"
    txt = "txt"
    slides = "slides"
    arxiv = "arxiv"
    notes = "notes"
    bibtex = "bibtex"
    latex = "latex"
    url = "url"
    book = "book"
    dataset = "dataset"


class SourceStatus(str, enum.Enum):
    ready = "ready"
    indexed = "indexed"
    error = "error"


@dataclass
class Source:
    id: uuid.UUID
    project_id: uuid.UUID
    # Nullable: `SourceService.remove` (soft delete) detaches this so the
    # `RESTRICT` FK on `project_sources.file_id` no longer blocks deleting
    # the file the source used to reference. Every live (non-soft-deleted)
    # row still has a real file behind it - the repository's `get`/`list`/
    # `list_all` all filter `deleted_at IS NULL`, so `None` is only ever
    # observed on a source that's already gone from the API's view.
    file_id: uuid.UUID | None
    source_type: SourceType
    authors: str | None
    year: str | None
    doi: str | None
    url: str | None
    description: str | None
    chunks_count: int | None
    status: SourceStatus
    created_at: datetime
    deleted_at: datetime | None


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
    storage_key: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    filename: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str] = mapped_column(Text, nullable=False)
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


class RunKind(str, enum.Enum):
    full = "full"
    regenerate_section = "regenerate_section"
    export = "export"


class RunStatus(str, enum.Enum):
    queued = "queued"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"
    cancelled = "cancelled"


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
    # without regenerating section content. There is no dedicated CLI flag
    # for this (`book_command.build_command` never reads it) - the effect
    # comes entirely from `resume=True` plus `GenerationService` not
    # deleting any `sections/<key>.md` before invoking the CLI, so it skips
    # every section and only rebuilds the requested export format.
    export_tex_only: bool = False
    # Set on a `regenerate_section` run's own `RunOptions` (issue #11):
    # appended as a "Writing instructions: ..." line to the target node's
    # `summary` in the run's `structure_graph.json` before the CLI runs,
    # since that `summary` is what `book_builder.py:generate_contents`
    # sends the writer agent as `section_summary`. Ignored for every other
    # run kind.
    prompt_modifier: str | None = None
    # Issue #128: resolved at run-creation time by `RunService` to the request's own
    # `llmModel` if given, else the project's `llm_model` - `book_command.build_command` sets
    # `AUTOGENBOOK_LLM_MODEL` in the CLI subprocess env from this, overriding any parent-provided
    # value. `None` only for a run row persisted before this field existed (tolerated by
    # `_run_options_from_json`'s dataclass-default fallback) - `RunService`'s read paths
    # (`get`/`list`) backfill it from the project/deployment default before it ever reaches a
    # client, so `RunOptionsOut.llmModel` is always a concrete string on the wire.
    llm_model: str | None = None


@dataclass
class RunEvent:
    """One structured progress event parsed out of a CLI subprocess run."""

    seq: int
    ts: datetime
    level: str
    stage: str
    message: str
    payload: dict[str, Any] | None = None


class ArtifactKind(str, enum.Enum):
    markdown = "markdown"
    tex = "tex"
    pdf = "pdf"
    structure_graph = "structure_graph"
    book_structure = "book_structure"
    section = "section"
    section_review = "section_review"
    kb_sources = "kb_sources"
    run_meta = "run_meta"
    llm_usage = "llm_usage"
    audit_report = "audit_report"
    log = "log"
    bib = "bib"
    other = "other"


@dataclass
class RunArtifact:
    """One file a run produced, uploaded to object storage as a `File`
    (`kind=artifact`) and indexed here by its path within the run's work
    directory - `relative_path` is what `GET /runs/{id}/artifacts` shows and
    `api.infrastructure.cli.artifacts` classifies it from."""

    id: uuid.UUID
    run_id: uuid.UUID
    file_id: uuid.UUID
    kind: ArtifactKind
    relative_path: str


@dataclass
class Run:
    """One book-mode CLI execution: a queue entry plus its outcome.

    `options` is this run's own snapshot of `RunOptions` (never re-read from
    the project afterward), so a run started before a project setting
    changed keeps running/reporting under the options it was actually
    launched with.
    """

    id: uuid.UUID
    project_id: uuid.UUID
    kind: RunKind
    status: RunStatus
    options: RunOptions
    base_run_id: uuid.UUID | None
    target_node_id: uuid.UUID | None
    # The target node's `status` immediately before this `regenerate_section`
    # run started (`RunService.regenerate_node` sets it to `drafting` at
    # creation and stashes the prior value here) - `GenerationService`
    # restores it if the run doesn't succeed. `None` for every other kind.
    target_node_previous_status: NodeStatus | None
    work_dir: str
    exit_code: int | None
    error: str | None
    cancel_requested: bool
    locked_by: str | None
    heartbeat_at: datetime | None
    queued_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    total_tokens: int | None
    total_cost_usd: float | None
    started_by: uuid.UUID | None = None
    # Derived, never persisted - see `Project.owner_name`'s docstring; joined
    # in by `SqlAlchemyRunRepository`.
    started_by_name: str | None = None


@dataclass
class LlmModelInfo:
    """One model the configured LLM endpoint's `GET /models` offers (issue #128) -
    `id` is what a project/run's `llm_model` actually stores and what
    `AUTOGENBOOK_LLM_MODEL` is set to; `name` is a human-readable label some
    endpoints (e.g. OpenRouter) also return, `None` on ones that don't."""

    id: str
    name: str | None = None
