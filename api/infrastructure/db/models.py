from __future__ import annotations

import uuid
from datetime import datetime

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Mapped, mapped_column, relationship

from api.core.db import Base
from api.domain.models import OutputFormat, SourceStatus, SourceType, TargetAudience


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
        sa.UniqueConstraint(
            "project_id", "file_id", name="uq_project_sources_project_file"
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
