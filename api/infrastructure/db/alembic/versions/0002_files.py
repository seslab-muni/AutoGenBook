"""files

Revision ID: 0002_files
Revises: b0810326f75b
Create Date: 2026-09-07 12:30:00.000000

"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0002_files'
down_revision: Union[str, None] = 'b0810326f75b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

file_kind = sa.Enum("upload", "artifact", name="file_kind")


def upgrade() -> None:
    op.create_table(
        "files",
        sa.Column("id", sa.Uuid(as_uuid=True), primary_key=True),
        sa.Column("storage_key", sa.Text(), nullable=False, unique=True),
        sa.Column("filename", sa.Text(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.CHAR(64), nullable=False),
        sa.Column("kind", file_kind, nullable=False),
        sa.Column("kb_eligible", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_files_sha256", "files", ["sha256"])


def downgrade() -> None:
    op.drop_index("ix_files_sha256", table_name="files")
    op.drop_table("files")
    file_kind.drop(op.get_bind(), checkfirst=True)
