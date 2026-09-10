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


class UserRecord(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)
    # Always stored lowercased (`AuthService`/`api/scripts/users.py` both
    # normalize before writing) so `get_by_email` can do a plain equality
    # lookup instead of a case-insensitive one.
    email: Mapped[str] = mapped_column(sa.Text, unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(sa.Text, nullable=False)
    password_hash: Mapped[str] = mapped_column(sa.Text, nullable=False)
    is_active: Mapped[bool] = mapped_column(sa.Boolean, nullable=False, default=True, server_default=sa.true())
    # Bumped on every password change; `AuthService.verify_token` rejects any
    # token whose `iat` predates this, so rotating a password is also "log
    # everyone out of that account" - the only revocation story #96 needs.
    password_changed_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True),
        server_default=sa.func.now(),
        onupdate=sa.func.now(),
        nullable=False,
    )


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
    # Nullable both for a legacy project predating this column and for one
    # whose owner account was later removed (`ON DELETE SET NULL`) - "Created
    # by -" in the UI, never a hard failure.
    owner_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
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
    # Issue #128: always a concrete model id - `ProjectService.create` resolves it from
    # `AUTOGENBOOK_LLM_MODEL`/`FALLBACK_LLM_MODEL` when the caller doesn't supply one, and
    # migration `0017_projects_llm_model` backfilled every pre-existing row the same way.
    llm_model: Mapped[str] = mapped_column(sa.Text, nullable=False)
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
    # Soft delete (issue #57): `DELETE /projects/{id}` only ever sets this,
    # following the same pattern sources/outline nodes already use - never a
    # SQL `DELETE`, so the project's `runs` rows (and everything cascading
    # from them: `run_artifacts`, `run_events`) stay in place. A hard
    # `session.delete` here used to cascade those away out from under
    # in-flight work: a run still `running` when its project's `DELETE`
    # returned 204 left the worker's `append_batch`/`_finalize` hitting an
    # FK violation or an `assert record is not None` against a row that no
    # longer existed, with the CLI subprocess still running unattended.
    # `SqlAlchemyProjectRepository.get`/`list` filter this out; `delete`
    # additionally refuses (409) while a run is still active for the
    # project - see `ProjectService.delete`.
    deleted_at: Mapped[datetime | None] = mapped_column(
        sa.DateTime(timezone=True), nullable=True
    )

    # `delete` above never issues a SQL `DELETE` through the ORM (soft
    # delete only, issue #57), so this relationship's `cascade` never
    # actually fires - cascading deletes are the `ON DELETE CASCADE` FK on
    # `project_sources.project_id`, enforced by Postgres directly. Nothing
    # reads `.sources` as an ORM attribute either (`SourceService`/
    # `ProjectService` both go through `SourceRepository`/counted queries
    # instead), so `lazy="selectin"` was pure overhead: every `session.get
    # (ProjectRecord, ...)` - which `_require_project` in sources/outline/
    # runs services calls on every request - issued an extra `SELECT
    # project_sources` to eagerly load a relationship nothing looked at
    # (issue #51). `lazy="raise"` turns any future accidental access into a
    # loud `InvalidRequestError` instead of a silent per-request query.
    sources: Mapped[list["SourceRecord"]] = relationship(
        "SourceRecord",
        cascade="all, delete-orphan",
        lazy="raise",
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
        sa.Index("ix_project_sources_project_id", "project_id"),
        # `SqlAlchemyFileRepository.is_referenced` filters on exactly this
        # (`file_id`, `deleted_at IS NULL`) on every `DELETE /files/{id}` -
        # unindexed, that was a sequential scan of the whole table (issue
        # #54). Partial on active rows only, matching what the query (and
        # the `uq_project_sources_project_file_active` index above) already
        # scope to.
        sa.Index(
            "ix_project_sources_file_id_active",
            "file_id",
            postgresql_where=sa.text("deleted_at IS NULL"),
            sqlite_where=sa.text("deleted_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    # Nullable so a soft-deleted row (`deleted_at` set) can detach from its
    # file (`SourceService.remove`) instead of the `RESTRICT` FK permanently
    # blocking deletion of a file whose only references have been removed.
    file_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("files.id", ondelete="RESTRICT"), nullable=True
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
        server_default="ready",
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
        #
        # `postgresql_nulls_not_distinct` (Postgres 15+, the version this
        # project targets - `docker-compose.yml` pins `postgres:16-alpine`)
        # makes two rows with `parent_id IS NULL` (root-level siblings)
        # compare equal on that column instead of Postgres's default "every
        # NULL is distinct from every other NULL" - without it, two root
        # nodes could silently share the same `order_index`, since the
        # *whole* indexed tuple was never considered a duplicate whenever
        # any one column was NULL (issue #67). SQLite has no equivalent
        # syntax and ignores this dialect-specific option entirely, so the
        # collision there is caught by `OutlineService.create` routing an
        # explicit `orderIndex` through the same shift-siblings logic
        # `update` already uses, rather than by this index.
        sa.Index(
            "uq_outline_nodes_project_parent_order",
            "project_id",
            "parent_id",
            "order_index",
            unique=True,
            postgresql_where=sa.text("deleted_at IS NULL"),
            sqlite_where=sa.text("deleted_at IS NULL"),
            postgresql_nulls_not_distinct=True,
        ),
        # `delete_subtree`'s recursive CTE walks descendants by `parent_id`
        # (and any parent delete/cascade scans by it too) - unindexed, that
        # was a full table scan per level (issue #54). Partial on active
        # rows, matching every read path (`list`/`get`/`_assert_live_parent`)
        # which already filters `deleted_at IS NULL`.
        sa.Index(
            "ix_outline_nodes_parent_id_active",
            "parent_id",
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
    summary: Mapped[str] = mapped_column(sa.Text, nullable=False, default="", server_default="")
    status: Mapped[NodeStatus] = mapped_column(
        sa.Enum(
            NodeStatus,
            name="node_status",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
        default=NodeStatus.NOT_STARTED,
        server_default="not_started",
    )
    target_pages: Mapped[float] = mapped_column(sa.Numeric(8, 2), nullable=False)
    word_budget: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    actual_words: Mapped[int] = mapped_column(
        sa.Integer, nullable=False, default=0, server_default="0"
    )
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
    content_markdown: Mapped[str] = mapped_column(
        sa.Text, nullable=False, default="", server_default=""
    )
    content_latex: Mapped[str] = mapped_column(
        sa.Text, nullable=False, default="", server_default=""
    )
    rag_citations: Mapped[list[dict]] = mapped_column(
        _jsonb(), nullable=False, default=list, server_default="[]"
    )
    reviewer_score: Mapped[float | None] = mapped_column(sa.Numeric, nullable=True)
    reviewer_notes: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    structure_locked: Mapped[bool] = mapped_column(
        sa.Boolean, nullable=False, default=True, server_default=sa.true()
    )
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
        # (`RunRepository.get_active_for_project`, still used by the outline
        # structural-edit guard and project delete - see `uq_runs_project_
        # running` below for why queueing itself no longer reads this) both
        # filter on this; partial so the index stays small as terminal runs
        # accumulate.
        sa.Index(
            "ix_runs_status_active",
            "status",
            postgresql_where=sa.text("status IN ('queued', 'running')"),
            sqlite_where=sa.text("status IN ('queued', 'running')"),
        ),
        # Issue #134: backstop for "one *running* run per project" under
        # concurrent claims - `SqlAlchemyRunQueue.claim`'s own
        # NOT-EXISTS-gated `SELECT ... FOR UPDATE SKIP LOCKED` can still let
        # two slots pass the gate for two queued runs of the same project in
        # the same instant; the second `UPDATE ... SET status='running'`
        # then violates this index and `claim` catches the resulting
        # `IntegrityError` and returns `None` for that slot. Unlike its
        # predecessor `uq_runs_project_active`, this only constrains
        # `running` rows - a project may hold several `queued` rows at once
        # (`MAX_QUEUED_RUNS_PER_PROJECT`), enforced by `queue_admission_
        # blocker` in `api/application/runs.py`, not by a unique index.
        sa.Index(
            "uq_runs_project_running",
            "project_id",
            unique=True,
            postgresql_where=sa.text("status = 'running'"),
            sqlite_where=sa.text("status = 'running'"),
        ),
        # `SqlAlchemyRunRepository.list` (the full run-history list, not
        # just active runs) filters on `project_id` and orders by
        # `queued_at DESC` - `uq_runs_project_active` above is partial to
        # active rows only, so it can't serve this. Composite + the DESC
        # ordering it's already read in avoids both a scan and a separate
        # sort (issue #54).
        sa.Index("ix_runs_project_id_queued_at", "project_id", sa.text("queued_at DESC")),
        # `sweep_stale_work_dirs`'s `list_stale_work_dirs` groups over every
        # `runs` row by `work_dir` and filters on `max(finished_at) <
        # cutoff` every worker poll cycle - partial on terminal rows, the
        # only ones that ever carry a `finished_at` at all.
        sa.Index(
            "ix_runs_finished_at_terminal",
            "finished_at",
            postgresql_where=sa.text("status IN ('succeeded', 'failed', 'cancelled')"),
            sqlite_where=sa.text("status IN ('succeeded', 'failed', 'cancelled')"),
        ),
        # `RunRepository.list_by_work_dir` (issue #124: `RunService.retry`'s
        # succeeded-sibling guard) filters on equality here every retry
        # attempt - unindexed otherwise, since `ix_runs_finished_at_terminal`
        # above is keyed on `finished_at`, not `work_dir`.
        sa.Index("ix_runs_work_dir", "work_dir"),
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
    target_node_previous_status: Mapped[NodeStatus | None] = mapped_column(
        sa.Enum(
            NodeStatus,
            name="node_status",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=True,
    )
    status: Mapped[RunStatus] = mapped_column(
        sa.Enum(
            RunStatus,
            name="run_status",
            values_callable=lambda enum_cls: [member.value for member in enum_cls],
        ),
        nullable=False,
        default=RunStatus.queued,
        server_default="queued",
    )
    options: Mapped[dict] = mapped_column(
        _jsonb(), nullable=False, default=dict, server_default="{}"
    )
    work_dir: Mapped[str] = mapped_column(sa.Text, nullable=False)
    exit_code: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    error: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    cancel_requested: Mapped[bool] = mapped_column(
        sa.Boolean, nullable=False, default=False, server_default=sa.false()
    )
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
    # Nullable for the same reason as `projects.owner_id`: legacy runs
    # predate this column, and the triggering user's account may later be
    # removed - "Started by -" in the UI either way.
    started_by: Mapped[uuid.UUID | None] = mapped_column(
        sa.Uuid, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )


class RunArtifactRecord(Base):
    __tablename__ = "run_artifacts"
    __table_args__ = (
        sa.UniqueConstraint("run_id", "relative_path", name="uq_run_artifacts_run_id_path"),
        sa.Index("ix_run_artifacts_run_id", "run_id"),
        # `SqlAlchemyFileRepository.is_referenced` also checks this table by
        # `file_id` on every `DELETE /files/{id}` (issue #54) - unindexed
        # like `project_sources.file_id` was.
        sa.Index("ix_run_artifacts_file_id", "file_id"),
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
        sa.Index("ix_run_events_run_id", "run_id"),
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
