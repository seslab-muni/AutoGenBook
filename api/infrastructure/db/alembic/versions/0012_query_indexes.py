"""query_indexes

Revision ID: 0012_query_indexes
Revises: 0011_projects_soft_delete
Create Date: 2026-09-08 00:00:00.000000

Adds the indexes the repository layer's actual query filters were missing
(issue #54, from the 2026-09-07 `api/` review):

- `runs(project_id, queued_at DESC)`: `SqlAlchemyRunRepository.list` (the
  full run-history list, not just active runs) filters on `project_id` and
  orders by `queued_at DESC` - the existing `uq_runs_project_active` index
  is partial to `status IN ('queued', 'running')` only, so it can't serve
  this and every history page was a sequential scan + sort.
- `project_sources(file_id) WHERE deleted_at IS NULL` and
  `run_artifacts(file_id)`: `SqlAlchemyFileRepository.is_referenced` checks
  both tables by `file_id` on every `DELETE /files/{id}`, unindexed.
- `outline_nodes(parent_id) WHERE deleted_at IS NULL`:
  `OutlineRepository.delete_subtree`'s recursive CTE walks descendants by
  `parent_id` every call.
- `runs(finished_at) WHERE status IN ('succeeded', 'failed', 'cancelled')`:
  `sweep_stale_work_dirs`'s `list_stale_work_dirs` filters/aggregates on
  `finished_at` for terminal runs every worker poll cycle.

Also drops `ix_outline_nodes_project_id_cli_key`: `cli_key` is never
filtered on by any query (only ever read/written as a plain column), so the
index was dead weight incurring write overhead for nothing.

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0012_query_indexes'
down_revision: Union[str, None] = '0011_projects_soft_delete'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_index("ix_outline_nodes_project_id_cli_key", table_name="outline_nodes")

    op.create_index(
        "ix_runs_project_id_queued_at",
        "runs",
        ["project_id", sa.text("queued_at DESC")],
    )
    op.create_index(
        "ix_runs_finished_at_terminal",
        "runs",
        ["finished_at"],
        postgresql_where=sa.text("status IN ('succeeded', 'failed', 'cancelled')"),
        sqlite_where=sa.text("status IN ('succeeded', 'failed', 'cancelled')"),
    )
    op.create_index(
        "ix_project_sources_file_id_active",
        "project_sources",
        ["file_id"],
        postgresql_where=sa.text("deleted_at IS NULL"),
        sqlite_where=sa.text("deleted_at IS NULL"),
    )
    op.create_index("ix_run_artifacts_file_id", "run_artifacts", ["file_id"])
    op.create_index(
        "ix_outline_nodes_parent_id_active",
        "outline_nodes",
        ["parent_id"],
        postgresql_where=sa.text("deleted_at IS NULL"),
        sqlite_where=sa.text("deleted_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_outline_nodes_parent_id_active", table_name="outline_nodes")
    op.drop_index("ix_run_artifacts_file_id", table_name="run_artifacts")
    op.drop_index("ix_project_sources_file_id_active", table_name="project_sources")
    op.drop_index("ix_runs_finished_at_terminal", table_name="runs")
    op.drop_index("ix_runs_project_id_queued_at", table_name="runs")

    op.create_index(
        "ix_outline_nodes_project_id_cli_key", "outline_nodes", ["project_id", "cli_key"]
    )
