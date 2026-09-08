"""runs_started_by

Revision ID: 0015_runs_started_by
Revises: 0014_projects_owner_fk
Create Date: 2026-09-08 00:00:00.000000

Issue #96: every run now records who triggered it (`POST /projects/{id}/
runs`, `.../outline/{nodeId}/regenerate`, `POST /runs/{id}/exports`), shown
as "Started by ..." in the runs panel and run detail view. `ON DELETE SET
NULL`, same as `projects.owner_id` - a removed user account never blocks
deleting it, and a legacy or orphaned run just renders "-".

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '0015_runs_started_by'
down_revision: Union[str, None] = '0014_projects_owner_fk'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("runs", sa.Column("started_by", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(
        "fk_runs_started_by_users",
        "runs",
        "users",
        ["started_by"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_runs_started_by_users", "runs", type_="foreignkey")
    op.drop_column("runs", "started_by")
