"""runs_one_running_per_project

Revision ID: 0018_runs_running_per_project
Revises: 0017_projects_llm_model
Create Date: 2026-09-10 00:00:00.000000

Issue #134 (phase 1): lets a project hold several *queued* runs while only
one *running* run is ever active for it. Replaces `uq_runs_project_active`
(unique on `project_id` where `status IN ('queued', 'running')`) with
`uq_runs_project_running` (unique on `project_id` where `status =
'running'`) - the new admission cap on how many runs a project may have
*queued* at once lives in application code (`queue_admission_blocker` in
`api/application/runs.py`, `MAX_QUEUED_RUNS_PER_PROJECT`), not in the
schema; this index only ever needs to stop two rows from being `running` for
the same project at once, which is the actual concurrency hazard
`SqlAlchemyRunQueue.claim` (phase 1) relies on as its backstop.

"""
from __future__ import annotations

import logging
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0018_runs_running_per_project'
down_revision: Union[str, None] = '0017_projects_llm_model'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

logger = logging.getLogger("alembic.runtime.migration")


def upgrade() -> None:
    op.drop_index("uq_runs_project_active", table_name="runs")
    op.create_index(
        "uq_runs_project_running",
        "runs",
        ["project_id"],
        unique=True,
        postgresql_where=sa.text("status = 'running'"),
        sqlite_where=sa.text("status = 'running'"),
    )


def downgrade() -> None:
    # `uq_runs_project_active` forbids more than one queued-or-running row
    # per project - a deployment that ran under this migration's `upgrade()`
    # for any length of time is normally sitting in exactly the state that
    # violates it (one `running` run plus however many `queued` ones),
    # which would make recreating that index fail outright.
    #
    # Rank every *queued-or-running* row per project with the `running` row
    # (if any) always first - `(status <> 'running')` sorts `false` (0)
    # before `true` (1) - and queued rows after it in `queued_at` order (the
    # same "oldest wins" tie-break `SqlAlchemyRunQueue.claim` uses when no
    # row is running). Only ever cancel `queued` rows ranked below 1 - a
    # `running` row always ranks first when present, so it's never a
    # candidate, and a project with a `running` row loses *every* queued
    # row (only the running one may remain active), while a project with
    # none keeps its oldest queued row and loses the rest - either way
    # exactly one queued-or-running row per project survives, satisfying
    # the index this restores.
    bind = op.get_bind()
    result = bind.execute(
        sa.text(
            """
            WITH ranked AS (
                SELECT id,
                       row_number() OVER (
                           PARTITION BY project_id
                           ORDER BY (status <> 'running'), queued_at
                       ) AS rn
                FROM runs
                WHERE status IN ('queued', 'running')
            )
            UPDATE runs
            SET status = 'cancelled',
                cancel_requested = true,
                error = 'cancelled by 0018 downgrade: only one queued-or-running '
                        'run per project is allowed once uq_runs_project_active '
                        'is restored',
                finished_at = now()
            WHERE status = 'queued'
              AND id IN (SELECT id FROM ranked WHERE rn > 1)
            """
        )
    )
    # `result` is `None` under `alembic ... --sql` (offline mode just emits
    # the literal SQL text above rather than actually executing it, so
    # there's no rowcount to report) - only log a count when this is a real
    # run against a live database.
    if result is not None and result.rowcount:
        logger.info(
            "0018_runs_running_per_project downgrade: cancelled %d surplus "
            "queued run(s) to satisfy uq_runs_project_active",
            result.rowcount,
        )
    op.drop_index("uq_runs_project_running", table_name="runs")
    op.create_index(
        "uq_runs_project_active",
        "runs",
        ["project_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('queued', 'running')"),
        sqlite_where=sa.text("status IN ('queued', 'running')"),
    )
