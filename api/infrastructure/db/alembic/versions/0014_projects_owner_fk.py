"""projects_owner_fk

Revision ID: 0014_projects_owner_fk
Revises: 0013_users
Create Date: 2026-09-08 00:00:00.000000

`projects.owner_id` has existed since `0003_projects` but never had a real
FK - there was no `users` table for it to reference yet. Issue #96 adds one:
`ON DELETE SET NULL` so removing a user account never blocks deleting it
and simply leaves that project's "Created by" as legacy/unknown ("-" in the
UI), matching every other soft-ownership column in this schema.

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '0014_projects_owner_fk'
down_revision: Union[str, None] = '0013_users'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_foreign_key(
        "fk_projects_owner_id_users",
        "projects",
        "users",
        ["owner_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_projects_owner_id_users", "projects", type_="foreignkey")
