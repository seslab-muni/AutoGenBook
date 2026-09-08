"""projects_soft_delete

Revision ID: 0011_projects_soft_delete
Revises: 0010_outline_nulls_not_distinct
Create Date: 2026-09-08 00:00:00.000000

`DELETE /projects/{id}` used to hard-delete the row, cascading away every
`runs` row for it (and, from there, `run_artifacts`/`run_events`) via the
`ON DELETE CASCADE` FKs. Since the retention sweep (`sweep_stale_work_dirs`)
only ever enumerates work directories from still-existing `runs` rows, that
cascade permanently orphaned the project's work directory on disk (issue
#57) - potentially hundreds of MB, with nothing left in the database to
ever find and remove it. Deleting a project mid-run wasn't blocked either:
the run row vanished while the worker's CLI subprocess kept running
unattended against it.

`projects.deleted_at` follows the same soft-delete pattern already used for
`project_sources`/`outline_nodes`: `ProjectService.delete` now only sets
this (after checking for an active run), and `SqlAlchemyProjectRepository.
get`/`list` filter it out.

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0011_projects_soft_delete'
down_revision: Union[str, None] = '0010_outline_nulls_not_distinct'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("projects", "deleted_at")
