"""outline_order_nulls_not_distinct

Revision ID: 0010_outline_nulls_not_distinct
Revises: 0009_file_id_nullable
Create Date: 2026-09-08 00:00:00.000000

`uq_outline_nodes_project_parent_order` (`(project_id, parent_id,
order_index)`, partial on `deleted_at IS NULL`) never actually caught a
collision between two root-level nodes: Postgres's default unique-index
semantics treat every `NULL` as distinct from every other `NULL`, so two
rows with `parent_id IS NULL` were never considered duplicates no matter
what `order_index` they shared. `POST /outline` with an explicit
`orderIndex` at root level (`parent_id: null`) could silently create two
live root nodes sharing `order_index: 0` - which flows into `sectionNumber`/
`cliKey` and makes the outline order the CLI itself sees nondeterministic
(issue #67).

Postgres 15+ (this project targets 16, `docker-compose.yml`) supports
`NULLS NOT DISTINCT` on a unique index, which makes two NULLs compare equal
for uniqueness purposes - exactly what's needed here. `ALTER INDEX` can't
add this after the fact, so the index is dropped and recreated.

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0010_outline_nulls_not_distinct'
down_revision: Union[str, None] = '0009_file_id_nullable'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_index("uq_outline_nodes_project_parent_order", table_name="outline_nodes")
    op.create_index(
        "uq_outline_nodes_project_parent_order",
        "outline_nodes",
        ["project_id", "parent_id", "order_index"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
        sqlite_where=sa.text("deleted_at IS NULL"),
        postgresql_nulls_not_distinct=True,
    )


def downgrade() -> None:
    op.drop_index("uq_outline_nodes_project_parent_order", table_name="outline_nodes")
    op.create_index(
        "uq_outline_nodes_project_parent_order",
        "outline_nodes",
        ["project_id", "parent_id", "order_index"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
        sqlite_where=sa.text("deleted_at IS NULL"),
    )
