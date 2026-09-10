"""projects_llm_model

Revision ID: 0017_projects_llm_model
Revises: 0016_runs_work_dir_index
Create Date: 2026-09-10 00:00:00.000000

Issue #128: per-project LLM model selection. `projects.llm_model` is always a concrete model
id - added `NOT NULL` with a `server_default` so every existing row is backfilled at add-column
time from whatever `AUTOGENBOOK_LLM_MODEL` this deployment already had configured (falling back
to `openai/gpt-5-mini`, `openrouter_llm.py:default_model_name`'s own fallback), then the server
default is dropped so a project created after this migration always has the application supply
one explicitly (`ProjectService.create`), the same way every other required text column here
(`title`, `topic`, ...) has no server default of its own.

"""
from __future__ import annotations

import logging
import os
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0017_projects_llm_model'
down_revision: Union[str, None] = '0016_runs_work_dir_index'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Mirrors `openrouter_llm.py:default_model_name`'s own fallback and
# `api.core.settings.FALLBACK_LLM_MODEL` - duplicated here (rather than imported) since
# migrations must keep working unchanged even if the application's default ever changes.
_FALLBACK_LLM_MODEL = "openai/gpt-5-mini"

logger = logging.getLogger("alembic.runtime.migration")


def upgrade() -> None:
    env_value = os.environ.get("AUTOGENBOOK_LLM_MODEL", "").strip()
    backfill_model = env_value or _FALLBACK_LLM_MODEL
    # Issue #128 review: this only ever runs once (at add-column time), and a deployment that
    # forgets to forward `AUTOGENBOOK_LLM_MODEL` to whatever runs this migration (e.g. a Compose
    # `migrate` service with its own trimmed-down `environment:`) silently backfills every
    # existing project to `_FALLBACK_LLM_MODEL` instead - log which one actually happened so
    # that's visible in the migration's own output rather than only discoverable later by
    # querying `projects.llm_model`.
    logger.info(
        "0017_projects_llm_model: backfilling projects.llm_model=%r (%s)",
        backfill_model,
        "from AUTOGENBOOK_LLM_MODEL" if env_value else "fallback default - AUTOGENBOOK_LLM_MODEL was unset/empty",
    )
    op.add_column(
        "projects",
        sa.Column("llm_model", sa.Text(), nullable=False, server_default=backfill_model),
    )
    op.alter_column("projects", "llm_model", server_default=None)


def downgrade() -> None:
    op.drop_column("projects", "llm_model")
