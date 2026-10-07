"""node_comments

Revision ID: 0023_node_comments
Revises: 0022_users_llm_api_key
Create Date: 2026-10-07 00:00:00.000000

Issue #182 (margin workspace): `node_comments` holds the cards beside a
section's text - human comments/replies, AI suggestions and reviewer issues.
Soft delete via `deleted_at`.

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '0023_node_comments'
down_revision: Union[str, None] = '0022_users_llm_api_key'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "node_comments",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("node_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("author_id", sa.Uuid(), nullable=True),
        sa.Column("anchor", postgresql.JSONB().with_variant(sa.JSON(), "sqlite"), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("thread_id", sa.Uuid(), nullable=False),
        sa.Column("parent_id", sa.Uuid(), nullable=True),
        sa.Column("body_markdown", sa.Text(), server_default="", nullable=False),
        sa.Column(
            "payload",
            postgresql.JSONB().with_variant(sa.JSON(), "sqlite"),
            server_default="{}",
            nullable=False,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "kind IN ('comment', 'suggestion', 'review')", name="ck_node_comments_kind"
        ),
        sa.CheckConstraint(
            "(kind IN ('comment', 'review') AND status IN ('open', 'resolved', 'orphaned'))"
            " OR (kind = 'suggestion' AND status IN ('running', 'pending', 'accepted',"
            " 'rejected', 'failed', 'cancelled'))",
            name="ck_node_comments_kind_status",
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["node_id"], ["outline_nodes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["author_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["parent_id"], ["node_comments.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_node_comments_node_id_active",
        "node_comments",
        ["node_id"],
        postgresql_where=sa.text("deleted_at IS NULL"),
    )
    op.create_index(
        "ix_node_comments_project_id_active",
        "node_comments",
        ["project_id"],
        postgresql_where=sa.text("deleted_at IS NULL"),
    )
    op.create_index("ix_node_comments_thread_id", "node_comments", ["thread_id"])
    op.create_index("ix_node_comments_parent_id", "node_comments", ["parent_id"])


def downgrade() -> None:
    op.drop_index("ix_node_comments_thread_id", table_name="node_comments")
    op.drop_index("ix_node_comments_parent_id", table_name="node_comments")
    op.drop_index("ix_node_comments_project_id_active", table_name="node_comments")
    op.drop_index("ix_node_comments_node_id_active", table_name="node_comments")
    op.drop_table("node_comments")
