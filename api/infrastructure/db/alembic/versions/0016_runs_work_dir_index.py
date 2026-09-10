"""runs_work_dir_index

Revision ID: 0016_runs_work_dir_index
Revises: 0015_runs_started_by
Create Date: 2026-09-10 00:00:00.000000

Adds `runs(work_dir)`: issue #124's `RunRepository.list_by_work_dir`
(`RunService.retry`'s succeeded-sibling guard) filters on `work_dir` by
equality on every retry attempt, and `sweep_stale_work_dirs`'s
`list_stale_work_dirs` (pre-existing) already `GROUP BY work_dir` every
worker poll cycle - neither was covered by an index, both now are.

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '0016_runs_work_dir_index'
down_revision: Union[str, None] = '0015_runs_started_by'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index("ix_runs_work_dir", "runs", ["work_dir"])


def downgrade() -> None:
    op.drop_index("ix_runs_work_dir", table_name="runs")
