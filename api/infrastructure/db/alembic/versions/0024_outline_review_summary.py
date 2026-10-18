"""outline_nodes.review_summary

Revision ID: 0024_outline_review_summary
Revises: 0023_node_comments
Create Date: 2026-10-08 00:00:00.000000

Issue #182 (margin workspace, phase 3): the graph import stores each section's
latest reviewer verdict (`okToKeep`, suggested edits, retrieval queries) on the
node; the individual reviewer issues are `kind=review` rows in `node_comments`.

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '0024_outline_review_summary'
down_revision: Union[str, None] = '0023_node_comments'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "outline_nodes",
        sa.Column(
            "review_summary",
            postgresql.JSONB().with_variant(sa.JSON(), "sqlite"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("outline_nodes", "review_summary")
