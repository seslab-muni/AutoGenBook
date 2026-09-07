from __future__ import annotations

import uuid
from datetime import datetime

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Mapped, mapped_column, relationship

from api.core.db import Base
from api.domain.models import (
    ArtifactKind,
    MathLevel,
    NodeStatus,
    OutputFormat,
    RunKind,
    RunStatus,
    SourceStatus,
    SourceType,
    TargetAudience,
)


def _jsonb() -> sa.types.TypeEngine:
    # JSONB on Postgres (as specced), a plain JSON column on SQLite so the
    # test suite can build the schema with Base.metadata.create_all.
    return postgresql.JSONB().with_variant(sa.JSON(), "sqlite")


class ProjectRecord(Base):
    __tablename__ = "projects"
    __table_args__ = (
        sa.CheckConstraint(
            "total_pages_budget BETWEEN 5 AND 2000", name="ck_projects_total_pages_budget"
        ),
        sa.CheckConstraint(
            "equation_frequency_level BETWEEN 1 AND 5",
            name="ck_projects_equation_frequency_level",
        ),
        sa.CheckConstraint(
            "max_outline_levels BETWEEN 1 AND 5", name="ck_projects_max_outline_levels"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID | None] = mapped_column(sa.Uuid, nullable=True)
    title: Mapped[str] = mapped_column(sa.Text, nullable=False)
    subtitle: Mapped[str] = mapped_column(sa.Text, nullable=False)
    authors: Mapped[list[str]] = mapped_column(_jsonb(), nullable=False, default=list)
    topic: Mapped[str] = mapped_column(sa.Text, nullable=False)
    target_audience: Mapped[TargetAudience] = mapped_column(
        sa.Enum(
            TargetAudience,
            name="target_audience",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
    )
    total_pages_budget: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    equation_frequency_level: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    do_consider_outline: Mapped[bool] = mapped_column(sa.Boolean, nullable=False)
    do_consider_previous_sections: Mapped[bool] = mapped_column(sa.Boolean, nullable=False)
    output_format: Mapped[OutputFormat] = mapped_column(
        sa.Enum(
            OutputFormat,
            name="output_format",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
    )
    max_outline_levels: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    additional_requirements: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    last_run_id: Mapped[uuid.UUID | None] = mapped_column(sa.Uuid, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True),
        server_default=sa.func.now(),
        onupdate=sa.func.now(),
        nullable=False,
    )

    # `passive_deletes=False` (the default) makes the ORM issue explicit child
    # DELETEs when a project is deleted, so cascading works under SQLite too
    # (the test suite's engine doesn't enable `PRAGMA foreign_keys`), on top
    # of the `ON DELETE CASCADE` FK enforced by Postgres in production.
    # `lazy="selectin"` avoids a lazy-load attempt on the async session.
    sources: Mapped[list["SourceRecord"]] = relationship(
        "SourceRecord",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


class SourceRecord(Base):
    __tablename__ = "project_sources"
    __table_args__ = (
        # Soft delete (`deleted_at`) means the same file can be re-attached
        # to a project after its previous source row was removed, so the
        # uniqueness constraint only applies to active (non-deleted) rows.
        sa.Index(
            "uq_project_sources_project_file_active",
            "project_id",
            "file_id",
            unique=True,
            postgresql_where=sa.text("deleted_at IS NULL"),
            sqlite_where=sa.text("deleted_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    file_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("files.id", ondelete="RESTRICT"), nullable=False
    )
    source_type: Mapped[SourceType] = mapped_column(
        sa.Enum(
            SourceType,
            name="source_type",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
    )
    authors: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    year: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    doi: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    url: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    description: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    chunks_count: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    status: Mapped[SourceStatus] = mapped_column(
        sa.Enum(
            SourceStatus,
            name="source_status",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
        default=SourceStatus.ready,
    )
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        sa.DateTime(timezone=True), nullable=True
    )


class OutlineNodeRecord(Base):
    __tablename__ = "outline_nodes"
    __table_args__ = (
        sa.CheckConstraint(
            "equation_density_level BETWEEN 1 AND 5",
            name="ck_outline_nodes_equation_density_level",
        ),
        # Partial (not deferrable - Postgres doesn't allow that on an index)
        # so a soft-deleted row can keep occupying its old
        # (project_id, parent_id, order_index) tuple without colliding with
        # whatever live row now sits there. `OutlineRepository`'s
        # move/reorder writes use a temporary negative `order_index` to
        # avoid ever colliding within a single statement, since this
        # constraint can't defer the check to commit time the way a
        # deferrable table constraint could.
        sa.Index(
            "uq_outline_nodes_project_parent_order",
            "project_id",
            "parent_id",
            "order_index",
            unique=True,
            postgresql_where=sa.text("deleted_at IS NULL"),
            sqlite_where=sa.text("deleted_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("outline_nodes.id", ondelete="CASCADE"), nullable=True
    )
    order_index: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    cli_key: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    title: Mapped[str] = mapped_column(sa.Text, nullable=False)
    summary: Mapped[str] = mapped_column(sa.Text, nullable=False, default="")
    status: Mapped[NodeStatus] = mapped_column(
        sa.Enum(
            NodeStatus,
            name="node_status",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
        default=NodeStatus.NOT_STARTED,
    )
    target_pages: Mapped[float] = mapped_column(sa.Numeric(8, 2), nullable=False)
    word_budget: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    actual_words: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0)
    equation_density_level: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    math_level: Mapped[MathLevel] = mapped_column(
        sa.Enum(
            MathLevel,
            name="math_level",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
    )
    sub_prompt: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    content_markdown: Mapped[str] = mapped_column(sa.Text, nullable=False, default="")
    content_latex: Mapped[str] = mapped_column(sa.Text, nullable=False, default="")
    rag_citations: Mapped[list[dict]] = mapped_column(_jsonb(), nullable=False, default=list)
    reviewer_score: Mapped[float | None] = mapped_column(sa.Numeric, nullable=True)
    reviewer_notes: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    structure_locked: Mapped[bool] = mapped_column(sa.Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True),
        server_default=sa.func.now(),
        onupdate=sa.func.now(),
        nullable=False,
    )
    # Soft delete: `DELETE /outline/{nodeId}` sets this (recursively, for the
    # whole subtree) instead of issuing a SQL DELETE. NULL = live.
    deleted_at: Mapped[datetime | None] = mapped_column(
        sa.DateTime(timezone=True), nullable=True
    )


class RunRecord(Base):
    __tablename__ = "runs"
    __table_args__ = (
        # The queue claim query (`SqlAlchemyRunQueue.claim`) and the "does
        # this project already have an active run" check
        # (`RunRepository.get_active_for_project`) both filter on this;
        # partial so the index stays small as terminal runs accumulate.
        sa.Index(
            "ix_runs_status_active",
            "status",
            postgresql_where=sa.text("status IN ('queued', 'running')"),
            sqlite_where=sa.text("status IN ('queued', 'running')"),
        ),
        # Backstop for "one active run per project" under concurrent
        # requests: `RunService.create`'s own check-then-insert has a TOCTOU
        # gap between two racing requests, so the invariant is enforced here
        # instead - `SqlAlchemyRunRepository.add` turns the resulting
        # `IntegrityError` into a `Conflict`.
        sa.Index(
            "uq_runs_project_active",
            "project_id",
            unique=True,
            postgresql_where=sa.text("status IN ('queued', 'running')"),
            sqlite_where=sa.text("status IN ('queued', 'running')"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[RunKind] = mapped_column(
        sa.Enum(
            RunKind,
            name="run_kind",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
    )
    base_run_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("runs.id", ondelete="SET NULL"), nullable=True
    )
    target_node_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("outline_nodes.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[RunStatus] = mapped_column(
        sa.Enum(
            RunStatus,
            name="run_status",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
        default=RunStatus.queued,
    )
    options: Mapped[dict] = mapped_column(_jsonb(), nullable=False, default=dict)
    work_dir: Mapped[str] = mapped_column(sa.Text, nullable=False)
    exit_code: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    error: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    cancel_requested: Mapped[bool] = mapped_column(sa.Boolean, nullable=False, default=False)
    locked_by: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(
        sa.DateTime(timezone=True), nullable=True
    )
    queued_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
    )
    started_at: Mapped[datetime | None] = mapped_column(
        sa.DateTime(timezone=True), nullable=True
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        sa.DateTime(timezone=True), nullable=True
    )
    total_tokens: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    total_cost_usd: Mapped[float | None] = mapped_column(sa.Numeric, nullable=True)


class RunArtifactRecord(Base):
    __tablename__ = "run_artifacts"
    __table_args__ = (
        sa.UniqueConstraint("run_id", "relative_path", name="uq_run_artifacts_run_id_path"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)
    run_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("runs.id", ondelete="CASCADE"), nullable=False
    )
    file_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("files.id", ondelete="RESTRICT"), nullable=False
    )
    kind: Mapped[ArtifactKind] = mapped_column(
        sa.Enum(
            ArtifactKind,
            name="artifact_kind",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
    )
    relative_path: Mapped[str] = mapped_column(sa.Text, nullable=False)


class RunEventRecord(Base):
    __tablename__ = "run_events"
    __table_args__ = (
        sa.UniqueConstraint("run_id", "seq", name="uq_run_events_run_id_seq"),
    )

    # `BigInteger` primary keys don't get SQLite's "INTEGER PRIMARY KEY"
    # rowid-alias autoincrement behavior (only a plain `Integer` column
    # does), so the sqlite test suite needs the `Integer` variant to get a
    # server-assigned id back at all; Postgres keeps the real `bigserial`.
    id: Mapped[int] = mapped_column(
        sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    run_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("runs.id", ondelete="CASCADE"), nullable=False
    )
    seq: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    ts: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True), nullable=False)
    level: Mapped[str] = mapped_column(sa.Text, nullable=False)
    stage: Mapped[str] = mapped_column(sa.Text, nullable=False)
    message: Mapped[str] = mapped_column(sa.Text, nullable=False)
    payload: Mapped[dict | None] = mapped_column(_jsonb(), nullable=True)
