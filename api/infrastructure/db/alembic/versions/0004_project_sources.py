"""project_sources

Revision ID: 0004_project_sources
Revises: 0003_projects
Create Date: 2026-09-07 15:00:00.000000

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '0004_project_sources'
down_revision: Union[str, None] = '0003_projects'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

source_type = sa.Enum(
    "pdf",
    "doc",
    "ppt",
    "md",
    "txt",
    "slides",
    "arxiv",
    "notes",
    "bibtex",
    "latex",
    "url",
    "book",
    "dataset",
    name="source_type",
)
source_status = sa.Enum("ready", "indexed", "error", name="source_status")


def upgrade() -> None:
    op.create_table(
        "project_sources",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "file_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("files.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("source_type", source_type, nullable=False),
        sa.Column("authors", sa.Text(), nullable=True),
        sa.Column("year", sa.Text(), nullable=True),
        sa.Column("doi", sa.Text(), nullable=True),
        sa.Column("url", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("chunks_count", sa.Integer(), nullable=True),
        sa.Column("status", source_status, nullable=False, server_default="ready"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("project_id", "file_id", name="uq_project_sources_project_file"),
    )
    op.create_index("ix_project_sources_project_id", "project_sources", ["project_id"])


def downgrade() -> None:
    op.drop_index("ix_project_sources_project_id", table_name="project_sources")
    op.drop_table("project_sources")
    op.execute("DROP TYPE IF EXISTS source_type")
    op.execute("DROP TYPE IF EXISTS source_status")
