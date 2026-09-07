from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.domain.models import (
    ArtifactKind,
    OutputFormat,
    Project,
    Run,
    RunKind,
    RunOptions,
    RunStatus,
    TargetAudience,
)
from api.infrastructure.cli.artifacts import collect_artifact_paths, upload_artifacts
from api.infrastructure.db.file_repository import SqlAlchemyFileRepository
from api.infrastructure.db.repositories import SqlAlchemyProjectRepository
from api.infrastructure.db.run_artifact_repository import SqlAlchemyRunArtifactRepository
from api.infrastructure.db.run_repository import SqlAlchemyRunRepository
from api.infrastructure.storage.memory import InMemoryFileStorage


def _write(path: Path, content: str = "x") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _make_project(**overrides) -> Project:
    now = datetime.now(timezone.utc)
    defaults = dict(
        id=uuid.uuid4(),
        owner_id=None,
        title="AI in Teaching",
        subtitle="A practical guide",
        authors=["Ada Lovelace"],
        topic="using AI tools in university courses",
        target_audience=TargetAudience.GRADUATE,
        total_pages_budget=120,
        equation_frequency_level=2,
        do_consider_outline=True,
        do_consider_previous_sections=True,
        output_format=OutputFormat.MARKDOWN,
        max_outline_levels=3,
        additional_requirements=None,
        last_run_id=None,
        created_at=now,
        updated_at=now,
    )
    defaults.update(overrides)
    return Project(**defaults)


def _make_run(project_id: uuid.UUID, work_dir: Path, **overrides) -> Run:
    now = datetime.now(timezone.utc)
    defaults = dict(
        id=uuid.uuid4(),
        project_id=project_id,
        kind=RunKind.full,
        status=RunStatus.running,
        options=RunOptions(outline="generate", output_format="markdown"),
        base_run_id=None,
        target_node_id=None,
        target_node_previous_status=None,
        work_dir=str(work_dir),
        exit_code=None,
        error=None,
        cancel_requested=False,
        locked_by="worker-1",
        heartbeat_at=now,
        queued_at=now,
        started_at=now,
        finished_at=None,
        total_tokens=None,
        total_cost_usd=None,
    )
    defaults.update(overrides)
    return Run(**defaults)


async def _make_run_row(session: AsyncSession, work_dir: Path) -> Run:
    # `RunArtifactRecord.run_id` has an FK to `runs.id`, so uploading
    # artifacts against a run needs a real `runs`/`projects` row behind it
    # under FK enforcement (Postgres always, SQLite via the test fixture's
    # `PRAGMA foreign_keys=ON`).
    project = await SqlAlchemyProjectRepository(session).add(_make_project())
    return await SqlAlchemyRunRepository(session).add(_make_run(project.id, work_dir))


def _make_out_dir(tmp_path: Path) -> Path:
    out_dir = tmp_path / "run" / "out"
    _write(out_dir / "Fake Book.md", "**Author:** Nobody\n\nBody.\n")
    _write(out_dir / "Fake Book.tex", "tex")
    _write(out_dir / "Fake Book.pdf", "pdf")
    _write(out_dir / "structure_graph.json", "{}")
    _write(out_dir / "structure_graph.json.bak", "{}")
    _write(out_dir / "book_structure.json", "{}")
    _write(out_dir / "kb_sources.json", "{}")
    _write(out_dir / "run_meta.json", "{}")
    _write(out_dir / "llm_usage.jsonl", "{}")
    _write(out_dir / "audit_report.json", "{}")
    _write(out_dir / "refs.bib", "@article{x,}")
    _write(out_dir / "context_memory.json", "{}")
    _write(out_dir / "sections" / "1.md", "content")
    _write(out_dir / "section_reviews" / "1.json", "{}")
    _write(out_dir / "logs" / "run.log", "log line")
    _write(out_dir / ".kb_cache" / "index.pkl", "binary")
    return out_dir


def test_collect_artifact_paths_classifies_known_kinds(tmp_path: Path) -> None:
    out_dir = _make_out_dir(tmp_path)

    by_path = {str(path): kind for path, kind in collect_artifact_paths(out_dir)}
    assert by_path["Fake Book.md"] == ArtifactKind.markdown
    assert by_path["Fake Book.tex"] == ArtifactKind.tex
    assert by_path["Fake Book.pdf"] == ArtifactKind.pdf
    assert by_path["structure_graph.json"] == ArtifactKind.structure_graph
    assert by_path["book_structure.json"] == ArtifactKind.book_structure
    assert by_path["kb_sources.json"] == ArtifactKind.kb_sources
    assert by_path["run_meta.json"] == ArtifactKind.run_meta
    assert by_path["llm_usage.jsonl"] == ArtifactKind.llm_usage
    assert by_path["audit_report.json"] == ArtifactKind.audit_report
    assert by_path["refs.bib"] == ArtifactKind.bib
    assert by_path["context_memory.json"] == ArtifactKind.other
    assert by_path["sections/1.md"] == ArtifactKind.section
    assert by_path["section_reviews/1.json"] == ArtifactKind.section_review
    assert by_path["logs/run.log"] == ArtifactKind.log


def test_collect_artifact_paths_skips_kb_cache_and_bak_files(tmp_path: Path) -> None:
    out_dir = _make_out_dir(tmp_path)

    paths = {str(path) for path, _kind in collect_artifact_paths(out_dir)}

    assert "structure_graph.json.bak" not in paths
    assert not any(p.startswith(".kb_cache") for p in paths)


def test_collect_artifact_paths_empty_when_out_dir_missing(tmp_path: Path) -> None:
    assert collect_artifact_paths(tmp_path / "does-not-exist") == []


async def test_upload_artifacts_creates_files_and_rows(tmp_path: Path, session_factory: async_sessionmaker[AsyncSession]) -> None:
    out_dir = _make_out_dir(tmp_path)

    async with session_factory() as session:
        run = await _make_run_row(session, tmp_path / "run")
        run_id = run.id
        files = SqlAlchemyFileRepository(session)
        run_artifacts = SqlAlchemyRunArtifactRepository(session)
        storage = InMemoryFileStorage()

        created = await upload_artifacts(out_dir, run_id, files, run_artifacts, storage)

        rows, total = await run_artifacts.list(run_id, limit=100, offset=0)

    assert total == len(created) == len(collect_artifact_paths(out_dir))
    relative_paths = {artifact.relative_path for artifact in rows}
    assert "Fake Book.md" in relative_paths
    assert "sections/1.md" in relative_paths


async def test_upload_artifacts_rewrites_author_line_when_authors_given(
    tmp_path: Path, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    out_dir = _make_out_dir(tmp_path)

    async with session_factory() as session:
        run = await _make_run_row(session, tmp_path / "run")
        run_id = run.id
        files = SqlAlchemyFileRepository(session)
        run_artifacts = SqlAlchemyRunArtifactRepository(session)
        storage = InMemoryFileStorage()

        await upload_artifacts(
            out_dir, run_id, files, run_artifacts, storage, authors=["Ada Lovelace", "Alan Turing"]
        )

        rows, _ = await run_artifacts.list(run_id, limit=100, offset=0)
        markdown_row = next(a for a in rows if a.kind == ArtifactKind.markdown)
        file = await files.get(markdown_row.file_id)
        assert file is not None
        content = b"".join([chunk async for chunk in await storage.open(file.storage_key)]).decode("utf-8")

    assert "**Author:** Ada Lovelace, Alan Turing" in content
    assert "Nobody" not in content


async def test_upload_artifacts_rewrites_author_line_with_non_utf8_bytes_without_failing(
    tmp_path: Path, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    # A single bad byte in the main Markdown file used to raise a strict
    # `.decode("utf-8")` inside the per-file loop, and since the whole loop
    # ran inside one `try` at the call site, that silently skipped every
    # remaining artifact too (issue #78's secondary bug) - the sorted walk
    # visits "Fake Book.md" before "sections/1.md".
    out_dir = _make_out_dir(tmp_path)
    (out_dir / "Fake Book.md").write_bytes(b"**Author:** Nobody\n\nBody \xff bytes.\n")

    async with session_factory() as session:
        run = await _make_run_row(session, tmp_path / "run")
        run_id = run.id
        files = SqlAlchemyFileRepository(session)
        run_artifacts = SqlAlchemyRunArtifactRepository(session)
        storage = InMemoryFileStorage()

        created = await upload_artifacts(
            out_dir, run_id, files, run_artifacts, storage, authors=["Ada Lovelace"]
        )

        rows, _ = await run_artifacts.list(run_id, limit=100, offset=0)
        markdown_row = next(a for a in rows if a.kind == ArtifactKind.markdown)
        file = await files.get(markdown_row.file_id)
        assert file is not None
        content = b"".join(
            [chunk async for chunk in await storage.open(file.storage_key)]
        ).decode("utf-8")

    assert len(created) == len(collect_artifact_paths(out_dir))
    assert "sections/1.md" in {a.relative_path for a in rows}
    assert "**Author:** Ada Lovelace" in content


async def test_upload_artifacts_is_idempotent_on_rerun(
    tmp_path: Path, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    out_dir = _make_out_dir(tmp_path)

    async with session_factory() as session:
        run = await _make_run_row(session, tmp_path / "run")
        run_id = run.id
        files = SqlAlchemyFileRepository(session)
        run_artifacts = SqlAlchemyRunArtifactRepository(session)
        storage = InMemoryFileStorage()

        first = await upload_artifacts(out_dir, run_id, files, run_artifacts, storage)
        first_file_ids = {artifact.file_id for artifact in first}

        # Work dir changes between the two calls (a file removed) - the
        # second upload should fully replace the first, not accumulate.
        (out_dir / "audit_report.json").unlink()
        second = await upload_artifacts(out_dir, run_id, files, run_artifacts, storage)

        rows, total = await run_artifacts.list(run_id, limit=100, offset=0)
        remaining_files = [await files.get(fid) for fid in first_file_ids]

    assert total == len(second) == len(collect_artifact_paths(out_dir))
    assert "audit_report.json" not in {a.relative_path for a in rows}
    # The first upload's file blobs/rows are gone, not just superseded.
    assert all(f is None for f in remaining_files)
