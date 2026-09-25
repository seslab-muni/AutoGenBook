"""outline_source_scope

Revision ID: 0019_outline_source_scope
Revises: 0018_runs_running_per_project
Create Date: 2026-09-25 00:00:00.000000

Issue #138: per-node knowledge-base scoping. `outline_nodes.source_scope`
(`inherit` | `all` | `selected`, text + CHECK) and `outline_nodes.source_ids`
(JSONB list of `project_sources.id` strings). Every existing node is
backfilled to `inherit` / `[]`, i.e. exactly today's behaviour (every section
searches every source).

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '0019_outline_source_scope'
down_revision: Union[str, None] = '0018_runs_running_per_project'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "outline_nodes",
        sa.Column("source_scope", sa.Text(), nullable=False, server_default="inherit"),
    )
    op.add_column(
        "outline_nodes",
        sa.Column(
            "source_ids",
            postgresql.JSONB(),
            nullable=False,
            server_default="[]",
        ),
    )
    op.create_check_constraint(
        "ck_outline_nodes_source_scope",
        "outline_nodes",
        "source_scope IN ('inherit', 'all', 'selected')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_outline_nodes_source_scope", "outline_nodes", type_="check")
    op.drop_column("outline_nodes", "source_ids")
    op.drop_column("outline_nodes", "source_scope")
