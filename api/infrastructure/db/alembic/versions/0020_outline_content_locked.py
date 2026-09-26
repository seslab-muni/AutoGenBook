"""outline_content_locked

Revision ID: 0020_outline_content_locked
Revises: 0019_outline_source_scope
Create Date: 2026-09-26 00:00:00.000000

Issue #113: `outline_nodes.content_locked` - a leaf the user marked as
"keep as-is". A full run ships its `content_markdown` into the work dir and
the CLI copies it verbatim instead of re-writing it (while still feeding it
into the cross-section context), and `graph_import` never overwrites it on
the way back. Backfilled `false` for every existing node, i.e. exactly
today's behaviour.

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0020_outline_content_locked'
down_revision: Union[str, None] = '0019_outline_source_scope'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "outline_nodes",
        sa.Column("content_locked", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("outline_nodes", "content_locked")
