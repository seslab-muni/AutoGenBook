"""run_prev_status

Revision ID: 0008_run_prev_status
Revises: 0007_run_artifacts
Create Date: 2026-09-07 00:00:00.000000

Adds `runs.target_node_previous_status`: the target node's `status`
immediately before a `regenerate_section` run started, so
`GenerationService` can restore it if the run doesn't succeed (issue #11).
Reuses the `node_status` enum type already created by `0005_outline_nodes`
(`create_type=False` so this migration doesn't try to recreate it).

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '0008_run_prev_status'
down_revision: Union[str, None] = '0007_run_artifacts'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "runs",
        sa.Column(
            "target_node_previous_status",
            postgresql.ENUM(
                "not_started",
                "drafting",
                "review_ready",
                "compiled",
                name="node_status",
                create_type=False,
            ),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("runs", "target_node_previous_status")
