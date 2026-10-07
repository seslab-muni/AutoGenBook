"""revision_jobs, revision_events, one running revision per node

Revision ID: 0025_revision_jobs
Revises: 0024_outline_review_summary
Create Date: 2026-10-08 12:00:00.000000

Issue #182 (margin workspace, phase 4): the in-process revision service keeps
a heartbeat / cancel flag per running suggestion (`revision_jobs`) and its
progress events (`revision_events`) in the database so any API replica can
stream or cancel a job it does not own, and a unique partial index on
`node_comments` allows at most one running revision per node.

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '0025_revision_jobs'
down_revision: Union[str, None] = '0024_outline_review_summary'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "revision_jobs",
        sa.Column("comment_id", sa.Uuid(), nullable=False),
        sa.Column("owner", sa.Text(), nullable=False),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("cancel_requested", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["comment_id"], ["node_comments.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("comment_id"),
    )
    op.create_table(
        "revision_events",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("comment_id", sa.Uuid(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("level", sa.Text(), nullable=False),
        sa.Column("stage", sa.Text(), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("payload", postgresql.JSONB().with_variant(sa.JSON(), "sqlite"), nullable=True),
        sa.ForeignKeyConstraint(["comment_id"], ["node_comments.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("comment_id", "seq", name="uq_revision_events_comment_id_seq"),
    )
    where = sa.text("kind = 'suggestion' AND status = 'running' AND deleted_at IS NULL")
    op.create_index(
        "uq_node_comments_running_suggestion",
        "node_comments",
        ["node_id"],
        unique=True,
        postgresql_where=where,
        sqlite_where=where,
    )


def downgrade() -> None:
    op.drop_index("uq_node_comments_running_suggestion", table_name="node_comments")
    op.drop_table("revision_events")
    op.drop_table("revision_jobs")
