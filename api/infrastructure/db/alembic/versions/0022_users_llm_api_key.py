"""users_llm_api_key

Revision ID: 0022_users_llm_api_key
Revises: 0021_runs_error_detail
Create Date: 2026-10-05 00:00:00.000000

Per-user LLM key: `users.llm_api_key_encrypted` (Fernet ciphertext, see
`api/core/secrets.py`), `llm_api_key_last4` (the only part shown back to the
user) and `llm_api_key_updated_at`. All three are `NULL` for every existing
row, meaning "no personal key" - that user's runs keep using the deployment key.

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0022_users_llm_api_key'
down_revision: Union[str, None] = '0021_runs_error_detail'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("llm_api_key_encrypted", sa.Text(), nullable=True))
    op.add_column("users", sa.Column("llm_api_key_last4", sa.Text(), nullable=True))
    op.add_column(
        "users", sa.Column("llm_api_key_updated_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("users", "llm_api_key_updated_at")
    op.drop_column("users", "llm_api_key_last4")
    op.drop_column("users", "llm_api_key_encrypted")
