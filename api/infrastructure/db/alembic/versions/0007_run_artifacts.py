"""run_artifacts

Revision ID: 0007_run_artifacts
Revises: 0006_runs
Create Date: 2026-09-07 00:00:00.000000

Adds `run_artifacts`: one row per file a run produced (uploaded to object
storage as a `files` row with `kind=artifact`), classified and indexed by
`api.infrastructure.cli.artifacts.upload_artifacts` after the CLI subprocess
exits. Read back through `GET /runs/{id}/artifacts`.

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '0007_run_artifacts'
down_revision: Union[str, None] = '0006_runs'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "run_artifacts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "run_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "file_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("files.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "kind",
            sa.Enum(
                "markdown",
                "tex",
                "pdf",
                "structure_graph",
                "book_structure",
                "section",
                "section_review",
                "kb_sources",
                "run_meta",
                "llm_usage",
                "audit_report",
                "log",
                "bib",
                "other",
                name="artifact_kind",
            ),
            nullable=False,
        ),
        sa.Column("relative_path", sa.Text(), nullable=False),
        sa.UniqueConstraint("run_id", "relative_path", name="uq_run_artifacts_run_id_path"),
    )
    op.create_index("ix_run_artifacts_run_id", "run_artifacts", ["run_id"])


def downgrade() -> None:
    op.drop_index("ix_run_artifacts_run_id", table_name="run_artifacts")
    op.drop_table("run_artifacts")
    op.execute("DROP TYPE IF EXISTS artifact_kind")
