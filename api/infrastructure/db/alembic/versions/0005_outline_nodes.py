"""outline_nodes

Revision ID: 0005_outline_nodes
Revises: 0003_projects
Create Date: 2026-09-07 00:00:00.000000

NOTE: this is deliberately chained onto `0003_projects` rather than
`0004_project_sources` (issue #5, developed concurrently in a sibling
worktree off the same base and not yet visible here). If `0004_project_sources`
has landed on `main` by the time this branch is rebased, this migration's
`down_revision` must be updated to `'0004_project_sources'` before merging so
the two migrations chain instead of forking the history.

`deleted_at` and the *partial* (not deferrable) unique index below implement
soft delete: `DELETE /outline/{nodeId}` (and a `PUT` full-tree replace) only
ever set `deleted_at`, never issue a SQL `DELETE` - a project-wide preference
adopted mid-issue, after #3 (files) and #4 (projects) already shipped with
hard deletes (tracked for a separate retrofit, not touched here). A plain
`UNIQUE (project_id, parent_id, order_index)` would collide with soft-deleted
rows still occupying their old position, so the constraint is scoped to
`WHERE deleted_at IS NULL` instead - and partial indexes can't be
`DEFERRABLE` in Postgres, so unlike the CLI's other structural constraints
this one relies entirely on `OutlineRepository`'s own two-phase (temporary
negative `order_index`, then final) writes to never collide, rather than on
the database deferring the check to commit time.

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '0005_outline_nodes'
down_revision: Union[str, None] = '0003_projects'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "outline_nodes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "parent_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("outline_nodes.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("order_index", sa.Integer(), nullable=False),
        sa.Column("cli_key", sa.Text(), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "status",
            sa.Enum(
                "not_started",
                "drafting",
                "review_ready",
                "compiled",
                name="node_status",
            ),
            nullable=False,
            server_default="not_started",
        ),
        sa.Column("target_pages", sa.Numeric(8, 2), nullable=False),
        sa.Column("word_budget", sa.Integer(), nullable=False),
        sa.Column("actual_words", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("equation_density_level", sa.Integer(), nullable=False),
        sa.Column(
            "math_level",
            sa.Enum(
                "introductory",
                "rigorous",
                "formal_proof",
                "applied",
                name="math_level",
            ),
            nullable=False,
        ),
        sa.Column("sub_prompt", sa.Text(), nullable=True),
        sa.Column("content_markdown", sa.Text(), nullable=False, server_default=""),
        sa.Column("content_latex", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "rag_citations", postgresql.JSONB(), nullable=False, server_default="[]"
        ),
        sa.Column("reviewer_score", sa.Numeric(), nullable=True),
        sa.Column("reviewer_notes", sa.Text(), nullable=True),
        sa.Column(
            "structure_locked", sa.Boolean(), nullable=False, server_default=sa.true()
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "equation_density_level BETWEEN 1 AND 5",
            name="ck_outline_nodes_equation_density_level",
        ),
    )
    op.create_index(
        "uq_outline_nodes_project_parent_order",
        "outline_nodes",
        ["project_id", "parent_id", "order_index"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
        sqlite_where=sa.text("deleted_at IS NULL"),
    )
    op.create_index(
        "ix_outline_nodes_project_id_cli_key", "outline_nodes", ["project_id", "cli_key"]
    )


def downgrade() -> None:
    op.drop_index("ix_outline_nodes_project_id_cli_key", table_name="outline_nodes")
    op.drop_index("uq_outline_nodes_project_parent_order", table_name="outline_nodes")
    op.drop_table("outline_nodes")
    op.execute("DROP TYPE IF EXISTS node_status")
    op.execute("DROP TYPE IF EXISTS math_level")
