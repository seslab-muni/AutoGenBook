"""project_sources_file_id_nullable

Revision ID: 0009_file_id_nullable
Revises: 0008_run_prev_status
Create Date: 2026-09-07 00:00:00.000000

`project_sources.file_id` -> `files.id` is `ON DELETE RESTRICT`. Soft
deleting a source (`SourceService.remove`, issue #10) used to leave the row
- and its `file_id` - in place, so the FK kept blocking deletion of a file
whose only references had all been "removed" from the API's point of view
(`is_referenced` already treats a soft-deleted row as a non-reference, but
the database itself never agreed). `SourceService.remove` now also nulls out
`file_id` on the soft-deleted row, so this column has to accept NULL (issue
#70).

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0009_file_id_nullable'
down_revision: Union[str, None] = '0008_run_prev_status'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "project_sources",
        "file_id",
        existing_type=sa.Uuid(),
        nullable=True,
    )


def downgrade() -> None:
    # Fails loudly (a NOT NULL violation) if any soft-deleted row has
    # `file_id IS NULL` by this point - that data loss (which file a removed
    # source used to point at) isn't something this migration can safely
    # reconstruct, so a rolled-back deploy that hit this needs a manual data
    # decision rather than a silent guess here.
    op.alter_column(
        "project_sources",
        "file_id",
        existing_type=sa.Uuid(),
        nullable=False,
    )
