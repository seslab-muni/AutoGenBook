"""Regression coverage for issue #54: the repository layer's actual query
filters (`SqlAlchemyRunRepository.list`/`list_stale_work_dirs`,
`SqlAlchemyFileRepository.is_referenced`,
`SqlAlchemyOutlineRepository.delete_subtree`) must be backed by an index the
ORM's own `Base.metadata` declares, so `alembic revision --autogenerate`
never tries to drop/recreate one migrations already created out from under
it, and a fresh `create_all` (the test suite's own schema, see
`conftest.session_factory`) always includes them.

Partial-index `WHERE` clauses (Postgres/SQLite `postgresql_where`/
`sqlite_where`) aren't asserted here - the migration itself
(`0012_query_indexes.py`) is validated separately, offline, via
`alembic upgrade head --sql` against Postgres DDL, since SQLite's own
`CREATE INDEX ... WHERE` support doesn't exercise the same syntax."""

from __future__ import annotations

from api.core.db import Base
from api.infrastructure.db import models  # noqa: F401 - registers the ORM models on Base


def _index_names(table_name: str) -> set[str]:
    return {index.name for index in Base.metadata.tables[table_name].indexes}


def test_runs_table_declares_project_id_queued_at_index() -> None:
    assert "ix_runs_project_id_queued_at" in _index_names("runs")


def test_runs_table_declares_finished_at_terminal_index() -> None:
    assert "ix_runs_finished_at_terminal" in _index_names("runs")


def test_project_sources_table_declares_file_id_active_index() -> None:
    assert "ix_project_sources_file_id_active" in _index_names("project_sources")


def test_run_artifacts_table_declares_file_id_index() -> None:
    assert "ix_run_artifacts_file_id" in _index_names("run_artifacts")


def test_outline_nodes_table_declares_parent_id_active_index() -> None:
    assert "ix_outline_nodes_parent_id_active" in _index_names("outline_nodes")


def test_outline_nodes_table_no_longer_declares_dead_cli_key_index() -> None:
    # `cli_key` is never filtered on by any query - only ever read/written
    # as a plain column - so this composite index was dead weight.
    assert "ix_outline_nodes_project_id_cli_key" not in _index_names("outline_nodes")


def test_runs_table_declares_work_dir_index() -> None:
    # issue #124: `RunRepository.list_by_work_dir` (`RunService.retry`'s
    # succeeded-sibling guard) filters on `work_dir` by equality.
    assert "ix_runs_work_dir" in _index_names("runs")
