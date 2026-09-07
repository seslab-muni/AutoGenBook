"""projects

Revision ID: 0003_projects
Revises: b0810326f75b
Create Date: 2026-09-07 00:00:00.000000

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '0003_projects'
down_revision: Union[str, None] = 'b0810326f75b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("subtitle", sa.Text(), nullable=False),
        sa.Column("authors", postgresql.JSONB(), nullable=False),
        sa.Column("topic", sa.Text(), nullable=False),
        sa.Column(
            "target_audience",
            sa.Enum(
                "undergraduate",
                "graduate",
                "phd_researcher",
                "industry_practitioner",
                name="target_audience",
            ),
            nullable=False,
        ),
        sa.Column("total_pages_budget", sa.Integer(), nullable=False),
        sa.Column("equation_frequency_level", sa.Integer(), nullable=False),
        sa.Column("do_consider_outline", sa.Boolean(), nullable=False),
        sa.Column("do_consider_previous_sections", sa.Boolean(), nullable=False),
        sa.Column(
            "output_format",
            sa.Enum("markdown", "latex", "pdf", name="output_format"),
            nullable=False,
        ),
        sa.Column("max_outline_levels", sa.Integer(), nullable=False),
        sa.Column("additional_requirements", sa.Text(), nullable=True),
        sa.Column("last_run_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "total_pages_budget BETWEEN 5 AND 2000", name="ck_projects_total_pages_budget"
        ),
        sa.CheckConstraint(
            "equation_frequency_level BETWEEN 1 AND 5",
            name="ck_projects_equation_frequency_level",
        ),
        sa.CheckConstraint(
            "max_outline_levels BETWEEN 1 AND 5", name="ck_projects_max_outline_levels"
        ),
    )


def downgrade() -> None:
    op.drop_table("projects")
    op.execute("DROP TYPE IF EXISTS target_audience")
    op.execute("DROP TYPE IF EXISTS output_format")
