from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.application.graph_import import import_graph
from api.domain.models import (
    File,
    FileKind,
    MathLevel,
    NodeStatus,
    OutlineNode,
    OutputFormat,
    Project,
    Source,
    SourceStatus,
    SourceType,
    TargetAudience,
)
from api.infrastructure.db.file_repository import SqlAlchemyFileRepository
from api.infrastructure.db.models import OutlineNodeRecord
from api.infrastructure.db.outline_repository import SqlAlchemyOutlineRepository
from api.infrastructure.db.repositories import SqlAlchemyProjectRepository
from api.infrastructure.db.source_repository import SqlAlchemySourceRepository


async def _make_file_row(session: AsyncSession, filename: str = "notes.md") -> File:
    # `project_sources.file_id` has an FK to `files.id`, so a `Source` needs
    # a real file behind it under FK enforcement (Postgres always, SQLite
    # via the test fixture's `PRAGMA foreign_keys=ON`).
    file = File(
        id=uuid.uuid4(),
        storage_key=f"uploads/{uuid.uuid4()}/{filename}",
        filename=filename,
        content_type="text/markdown",
        size_bytes=1,
        sha256="0" * 64,
        kind=FileKind.upload,
        kb_eligible=True,
        created_at=datetime.now(timezone.utc),
    )
    await SqlAlchemyFileRepository(session).add(file)
    return file


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


def _make_node(project_id: uuid.UUID, parent_id: uuid.UUID | None, order_index: int, **overrides) -> OutlineNode:
    now = datetime.now(timezone.utc)
    defaults = dict(
        id=uuid.uuid4(),
        project_id=project_id,
        parent_id=parent_id,
        order_index=order_index,
        title=f"Node {order_index}",
        summary="",
        status=NodeStatus.NOT_STARTED,
        target_pages=1.0,
        word_budget=350,
        actual_words=0,
        equation_density_level=2,
        math_level=MathLevel.RIGOROUS,
        sub_prompt=None,
        content_markdown="",
        content_latex="",
        rag_citations=[],
        reviewer_score=None,
        reviewer_notes=None,
        structure_locked=True,
        created_at=now,
        updated_at=now,
    )
    defaults.update(overrides)
    return OutlineNode(**defaults)


def _write_structure_graph(out_dir: Path, nodes: dict, edges: list[list[str]]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "structure_graph.json").write_text(
        json.dumps({"graph": {}, "nodes": nodes, "edges": edges}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


async def test_import_graph_updates_matched_leaf_content_and_status(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        node = await SqlAlchemyOutlineRepository(session).add(
            _make_node(project.id, None, 0, title="Old Title")
        )

        work_dir = tmp_path / "run"
        out_dir = work_dir / "out"
        (out_dir / "sections").mkdir(parents=True)
        (out_dir / "sections" / "1.md").write_text("## New content\n\nBody text.\n", encoding="utf-8")
        _write_structure_graph(
            out_dir,
            nodes={"book": {}, "1": {"title": "New Title", "summary": "New summary", "n_pages": 2.0}},
            edges=[["book", "1"]],
        )

        await import_graph(
            project, work_dir, SqlAlchemyOutlineRepository(session), SqlAlchemySourceRepository(session)
        )

        refreshed = await SqlAlchemyOutlineRepository(session).get(node.id)

    assert refreshed is not None
    assert refreshed.title == "New Title"
    assert refreshed.summary == "New summary"
    assert refreshed.target_pages == 2.0
    assert refreshed.content_markdown == "## New content\n\nBody text.\n"
    assert refreshed.actual_words == 5
    assert refreshed.status == NodeStatus.COMPILED


async def test_import_graph_reads_files_off_the_event_loop(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path, monkeypatch
) -> None:
    """Regression for issue #55: `_load_json`/`_leaf_content_changes` used
    to do a plain sync `read_text`/`json.loads` per file, directly on
    whatever coroutine called `import_graph` - with `WORKER_CONCURRENCY >
    1` sharing one event loop, that blocked every other worker slot's
    drain loop (heartbeat, event flushing, cancellation) for however long
    the read took. They should now go through `run_in_threadpool`, i.e.
    run on a different thread than the test itself."""
    import threading

    from api.application import graph_import as graph_import_module

    main_thread = threading.current_thread()
    read_threads: list[threading.Thread] = []

    original_load_json_sync = graph_import_module._load_json_sync
    original_read_section_sync = graph_import_module._read_section_sync

    def spy_load_json_sync(path):
        read_threads.append(threading.current_thread())
        return original_load_json_sync(path)

    def spy_read_section_sync(path):
        read_threads.append(threading.current_thread())
        return original_read_section_sync(path)

    monkeypatch.setattr(graph_import_module, "_load_json_sync", spy_load_json_sync)
    monkeypatch.setattr(graph_import_module, "_read_section_sync", spy_read_section_sync)

    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        await SqlAlchemyOutlineRepository(session).add(
            _make_node(project.id, None, 0, title="Old Title")
        )

        work_dir = tmp_path / "run"
        out_dir = work_dir / "out"
        (out_dir / "sections").mkdir(parents=True)
        (out_dir / "sections" / "1.md").write_text("## New content\n\nBody text.\n", encoding="utf-8")
        _write_structure_graph(
            out_dir,
            nodes={"book": {}, "1": {"title": "New Title"}},
            edges=[["book", "1"]],
        )

        await import_graph(
            project, work_dir, SqlAlchemyOutlineRepository(session), SqlAlchemySourceRepository(session)
        )

    assert read_threads, "expected at least one file read during import_graph"
    assert all(t is not main_thread for t in read_threads)


async def test_import_graph_inserts_node_the_cli_subdivided(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        outline_repo = SqlAlchemyOutlineRepository(session)
        node_a = await outline_repo.add(_make_node(project.id, None, 0, title="Ch A"))
        node_b = await outline_repo.add(_make_node(project.id, None, 1, title="Ch B"))

        work_dir = tmp_path / "run"
        out_dir = work_dir / "out"
        (out_dir / "sections").mkdir(parents=True)
        (out_dir / "sections" / "1.md").write_text("Content A\n", encoding="utf-8")
        (out_dir / "sections" / "2-1.md").write_text("Content B1\n", encoding="utf-8")
        _write_structure_graph(
            out_dir,
            nodes={
                "book": {},
                "1": {"title": "Ch A", "summary": "", "n_pages": 1.0},
                "2": {"title": "Ch B", "summary": "", "n_pages": 3.0},
                "2-1": {"title": "Ch B part 1", "summary": "", "n_pages": 1.5},
            },
            edges=[["book", "1"], ["book", "2"], ["2", "2-1"]],
        )

        await import_graph(project, work_dir, outline_repo, SqlAlchemySourceRepository(session))

        flat = await outline_repo.list(project.id)

    by_title = {node.title: node for node in flat}
    assert set(by_title) == {"Ch A", "Ch B", "Ch B part 1"}

    new_node = by_title["Ch B part 1"]
    assert new_node.parent_id == node_b.id
    assert new_node.structure_locked is False
    assert new_node.content_markdown == "Content B1\n"
    assert new_node.status == NodeStatus.COMPILED

    # "Ch B" itself became a parent (no `sections/2.md`) - untouched content,
    # not marked compiled.
    assert by_title["Ch B"].id == node_b.id
    assert by_title["Ch B"].content_markdown == ""
    assert by_title["Ch B"].status == NodeStatus.NOT_STARTED
    assert by_title["Ch A"].id == node_a.id


async def test_import_graph_parses_rag_citations_from_kb_sources(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        outline_repo = SqlAlchemyOutlineRepository(session)
        await outline_repo.add(_make_node(project.id, None, 0))

        work_dir = tmp_path / "run"
        out_dir = work_dir / "out"
        (out_dir / "sections").mkdir(parents=True)
        (out_dir / "sections" / "1.md").write_text(
            "See [kb1] for background (page 3).\n", encoding="utf-8"
        )
        _write_structure_graph(out_dir, nodes={"book": {}, "1": {"title": "Node 0"}}, edges=[["book", "1"]])
        (out_dir / "kb_sources.json").write_text(
            json.dumps(
                {
                    "cite_keys": {
                        "kb1": {
                            "source_path": "/work/kb/srcid/notes.md",
                            "loc": "page 3",
                            "excerpt": "Some excerpt text",
                        }
                    },
                    "rids": {},
                    "page_keys": {},
                    "chunks": [],
                }
            ),
            encoding="utf-8",
        )

        await import_graph(project, work_dir, outline_repo, SqlAlchemySourceRepository(session))

        flat = await outline_repo.list(project.id)

    assert len(flat) == 1
    citations = flat[0].rag_citations
    assert len(citations) == 1
    assert citations[0]["id"] == "kb1"
    assert citations[0]["sourceDoc"] == "notes.md"
    assert citations[0]["pageNumber"] == "3"
    assert citations[0]["sectionSnippet"] == "Some excerpt text"


async def test_import_graph_updates_source_chunk_counts_and_status(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        outline_repo = SqlAlchemyOutlineRepository(session)
        source_repo = SqlAlchemySourceRepository(session)
        indexed_file = await _make_file_row(session, "indexed.md")
        missing_file = await _make_file_row(session, "missing.md")

        indexed_source = await source_repo.add(
            Source(
                id=uuid.uuid4(),
                project_id=project.id,
                file_id=indexed_file.id,
                source_type=SourceType.md,
                authors=None,
                year=None,
                doi=None,
                url=None,
                description=None,
                chunks_count=None,
                status=SourceStatus.ready,
                created_at=datetime.now(timezone.utc),
                deleted_at=None,
            )
        )
        missing_source = await source_repo.add(
            Source(
                id=uuid.uuid4(),
                project_id=project.id,
                file_id=missing_file.id,
                source_type=SourceType.md,
                authors=None,
                year=None,
                doi=None,
                url=None,
                description=None,
                chunks_count=None,
                status=SourceStatus.ready,
                created_at=datetime.now(timezone.utc),
                deleted_at=None,
            )
        )

        work_dir = tmp_path / "run"
        out_dir = work_dir / "out"
        out_dir.mkdir(parents=True)
        _write_structure_graph(out_dir, nodes={"book": {}}, edges=[])
        kb_dir = work_dir / "kb" / str(indexed_source.id)
        (out_dir / "kb_sources.json").write_text(
            json.dumps(
                {
                    "cite_keys": {},
                    "rids": {},
                    "page_keys": {},
                    "chunks": [
                        {"source_path": str(kb_dir / "notes.md"), "loc": "chunk 1"},
                        {"source_path": str(kb_dir / "notes.md"), "loc": "chunk 2"},
                    ],
                }
            ),
            encoding="utf-8",
        )

        await import_graph(project, work_dir, outline_repo, source_repo)

        refreshed_indexed = await source_repo.get(project.id, indexed_source.id)
        refreshed_missing = await source_repo.get(project.id, missing_source.id)

    assert refreshed_indexed is not None
    assert refreshed_indexed.chunks_count == 2
    assert refreshed_indexed.status == SourceStatus.indexed

    assert refreshed_missing is not None
    assert refreshed_missing.chunks_count == 0
    assert refreshed_missing.status == SourceStatus.error


async def test_import_graph_recomputes_word_budget_when_target_pages_changes(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        node = await SqlAlchemyOutlineRepository(session).add(
            _make_node(project.id, None, 0, target_pages=1.0, word_budget=350)
        )

        work_dir = tmp_path / "run"
        out_dir = work_dir / "out"
        (out_dir / "sections").mkdir(parents=True)
        (out_dir / "sections" / "1.md").write_text("Body text.\n", encoding="utf-8")
        _write_structure_graph(
            out_dir,
            nodes={"book": {}, "1": {"title": "Node 0", "n_pages": 4.0}},
            edges=[["book", "1"]],
        )

        await import_graph(
            project, work_dir, SqlAlchemyOutlineRepository(session), SqlAlchemySourceRepository(session)
        )

        refreshed = await SqlAlchemyOutlineRepository(session).get(node.id)

    assert refreshed is not None
    assert refreshed.target_pages == 4.0
    assert refreshed.word_budget == 4 * 350


async def test_import_graph_generate_mode_replaces_outline_instead_of_matching_positionally(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    """issue #65: with `outline="generate"` the CLI structured this run
    entirely on its own - its keys have no relationship to the project's
    existing, user-authored outline. Matching by recomputed positional
    `cli_key` would silently overwrite "Chapter A"/"Chapter B" with
    unrelated LLM-authored content; instead the whole outline is replaced
    (soft-deleted, not merged in place)."""
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        outline_repo = SqlAlchemyOutlineRepository(session)
        user_a = await outline_repo.add(
            _make_node(project.id, None, 0, title="User Chapter A", target_pages=5.0)
        )
        user_b = await outline_repo.add(_make_node(project.id, None, 1, title="User Chapter B"))

        work_dir = tmp_path / "run"
        out_dir = work_dir / "out"
        (out_dir / "sections").mkdir(parents=True)
        (out_dir / "sections" / "1.md").write_text("LLM chapter one body.\n", encoding="utf-8")
        _write_structure_graph(
            out_dir,
            nodes={
                "book": {},
                "1": {"title": "LLM Chapter One", "summary": "Auto summary", "n_pages": 3.0},
                "2": {"title": "LLM Chapter Two", "n_pages": 2.0},
            },
            edges=[["book", "1"], ["book", "2"]],
        )

        await import_graph(
            project,
            work_dir,
            outline_repo,
            SqlAlchemySourceRepository(session),
            outline_mode="generate",
        )

        flat = await outline_repo.list(project.id)
        old_a = await outline_repo.get(user_a.id)
        old_b = await outline_repo.get(user_b.id)

    # The user's original chapters are gone from every live read...
    live_ids = {n.id for n in flat}
    assert user_a.id not in live_ids
    assert user_b.id not in live_ids
    by_title = {n.title: n for n in flat}
    assert set(by_title) == {"LLM Chapter One", "LLM Chapter Two"}
    assert by_title["LLM Chapter One"].content_markdown == "LLM chapter one body.\n"
    assert by_title["LLM Chapter One"].target_pages == 3.0

    # ...but soft-deleted, not destroyed - `target_pages=5.0` (the user's
    # own value) was never overwritten by the LLM's unrelated "3.0".
    assert old_a is None and old_b is None
    async with session_factory() as session:
        old_a_record = await session.get(OutlineNodeRecord, user_a.id)
    assert old_a_record is not None
    assert old_a_record.deleted_at is not None
    assert old_a_record.target_pages == 5.0


async def test_import_graph_is_a_noop_without_structure_graph_json(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        outline_repo = SqlAlchemyOutlineRepository(session)
        node = await outline_repo.add(_make_node(project.id, None, 0))

        # `work_dir/out` never created - the run failed before producing anything.
        await import_graph(
            project, tmp_path / "run", outline_repo, SqlAlchemySourceRepository(session)
        )

        refreshed = await outline_repo.get(node.id)

    assert refreshed is not None
    assert refreshed.content_markdown == ""
    assert refreshed.status == NodeStatus.NOT_STARTED
