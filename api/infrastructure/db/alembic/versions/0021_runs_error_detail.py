"""runs_error_detail

Revision ID: 0021_runs_error_detail
Revises: 0020_outline_content_locked
Create Date: 2026-09-27 00:00:00.000000

`runs.error_detail`: the CLI's original error text for a failed run whose
`error` was rewritten into a user-facing "Generation with model X failed:
..." message by `api.application.run_errors.describe_cli_failure` (LLM
endpoint failures - a blocked or unknown model, a rejected key, a rate
limit). `NULL` for every existing row and for any run whose `error` is
still the CLI's own text.

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0021_runs_error_detail'
down_revision: Union[str, None] = '0020_outline_content_locked'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("runs", sa.Column("error_detail", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("runs", "error_detail")
