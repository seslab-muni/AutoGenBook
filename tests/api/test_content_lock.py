"""Issue #113: content-locked outline sections (`contentLocked`).

A locked leaf's `contentMarkdown` ships into a full run's work dir and the
CLI keeps it verbatim (see `tests/test_book_locked_sections.py` for the CLI
side); the API side validated here is the flag's rules, the "Unlock all"
bulk endpoint, what `StructureBuilder`/`_prepare_work_dir` emit, the import
skip that keeps curated content from being clobbered, and the regenerate /
legacyTex guards.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.application.book_spec import (
    StructureBuilder,
    locked_section_files,
    sync_content_locks_into_graph,
)
from api.application.graph_import import import_graph
from api.core.settings import get_settings
from api.domain.models import RunOptions
from api.domain.outline import OutlineTree, build_tree
from api.infrastructure.db.outline_repository import SqlAlchemyOutlineRepository
from api.infrastructure.db.repositories import SqlAlchemyProjectRepository
from api.infrastructure.db.source_repository import SqlAlchemySourceRepository
from api.infrastructure.storage.memory import InMemoryFileStorage

from tests.api.test_book_spec import _make_node, _make_project
from tests.api.test_generation_service import _make_run, _make_service
from tests.api.test_generation_service import _settings as _worker_settings
from tests.api.test_graph_import import _write_structure_graph
from tests.api.test_regenerate_and_export import (
    _create_node,
    _create_project,
    _drive_generation,
    _get_node,
    _run_full,
    _settings,
)

CURATED = "## Kept\n\nCurated by hand, must survive every run.\n"


async def _patch(client: AsyncClient, project_id: str, node_id: str, body: dict):
    return await client.patch(f"/api/v1/projects/{project_id}/outline/{node_id}", json=body)


async def _lock(client: AsyncClient, project_id: str, node_id: str, content: str = CURATED) -> dict:
    response = await _patch(client, project_id, node_id, {"contentMarkdown": content, "contentLocked": True})
    assert response.status_code == 200, response.text
    assert response.json()["contentLocked"] is True
    return response.json()


# ---------------------------------------------------------------------------
# PATCH rules
# ---------------------------------------------------------------------------


async def test_new_node_is_unlocked_and_the_flag_round_trips(authed_client: AsyncClient) -> None:
    project = await _create_project(authed_client)
    node = await _create_node(authed_client, project["id"], "Chapter")
    assert node["contentLocked"] is False

    response = await _patch(authed_client, project["id"], node["id"], {"contentMarkdown": CURATED})
    assert response.status_code == 200, response.text
    assert response.json()["contentLocked"] is False

    response = await _patch(authed_client, project["id"], node["id"], {"contentLocked": True})
    assert response.status_code == 200, response.text
    assert response.json()["contentLocked"] is True

    fetched = await _get_node(authed_client, project["id"], node["id"])
    assert fetched["contentLocked"] is True
    assert fetched["contentMarkdown"] == CURATED

    response = await _patch(authed_client, project["id"], node["id"], {"contentLocked": False})
    assert response.status_code == 200, response.text
    assert response.json()["contentLocked"] is False

    # An explicit null leaves the flag alone rather than writing NULL.
    await _lock(authed_client, project["id"], node["id"])
    response = await _patch(authed_client, project["id"], node["id"], {"contentLocked": None})
    assert response.status_code == 200, response.text
    assert response.json()["contentLocked"] is True


async def test_lock_422_on_blank_content(authed_client: AsyncClient) -> None:
    project = await _create_project(authed_client)
    node = await _create_node(authed_client, project["id"], "Chapter")

    for body in (
        {"contentLocked": True},
        {"contentLocked": True, "contentMarkdown": "   \n"},
    ):
        response = await _patch(authed_client, project["id"], node["id"], body)
        assert response.status_code == 422, (body, response.text)
        assert "content" in response.json()["detail"]

    fetched = await _get_node(authed_client, project["id"], node["id"])
    assert fetched["contentLocked"] is False


async def test_lock_409_on_a_node_with_children(authed_client: AsyncClient) -> None:
    project = await _create_project(authed_client)
    parent = await _create_node(authed_client, project["id"], "Chapter")
    await _create_node(authed_client, project["id"], "Section", parentId=parent["id"])

    response = await _patch(
        authed_client, project["id"], parent["id"], {"contentMarkdown": CURATED, "contentLocked": True}
    )
    assert response.status_code == 409, response.text
    assert "child" in response.json()["detail"]

    # Plain content edits on the parent are unaffected by the guard.
    response = await _patch(authed_client, project["id"], parent["id"], {"contentMarkdown": CURATED})
    assert response.status_code == 200, response.text


async def test_blanking_content_clears_the_lock_instead_of_422(authed_client: AsyncClient) -> None:
    project = await _create_project(authed_client)
    node = await _create_node(authed_client, project["id"], "Chapter")
    await _lock(authed_client, project["id"], node["id"])

    # The editor's debounced autosave emptying the section.
    response = await _patch(authed_client, project["id"], node["id"], {"contentMarkdown": ""})
    assert response.status_code == 200, response.text
    assert response.json()["contentLocked"] is False
    assert response.json()["contentMarkdown"] == ""

    # Editing a locked node's text (non-blank) keeps the lock: curating a
    # locked chapter by hand is the point.
    await _lock(authed_client, project["id"], node["id"])
    response = await _patch(authed_client, project["id"], node["id"], {"contentMarkdown": "Edited.\n"})
    assert response.status_code == 200, response.text
    assert response.json()["contentLocked"] is True


async def test_lock_toggle_is_allowed_while_a_run_is_active(
    app, authed_client: AsyncClient, tmp_path: Path
) -> None:
    """Unlike structural edits (issue #74), a lock cannot affect an in-flight
    run - its `book_structure.json` was already written - so it stays
    allowed, consistent with rename/status."""
    settings = _settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings
    project = await _create_project(authed_client)
    node = await _create_node(authed_client, project["id"], "Chapter")
    response = await _patch(authed_client, project["id"], node["id"], {"contentMarkdown": CURATED})
    assert response.status_code == 200, response.text

    queued = await authed_client.post(f"/api/v1/projects/{project['id']}/runs", json={"outline": "project"})
    assert queued.status_code == 202, queued.text

    response = await _patch(authed_client, project["id"], node["id"], {"contentLocked": True})
    assert response.status_code == 200, response.text
    assert response.json()["contentLocked"] is True


# ---------------------------------------------------------------------------
# Unlock all
# ---------------------------------------------------------------------------


async def test_unlock_all_clears_every_lock_and_is_idempotent(authed_client: AsyncClient) -> None:
    project = await _create_project(authed_client)
    a = await _create_node(authed_client, project["id"], "A")
    b = await _create_node(authed_client, project["id"], "B")
    c = await _create_node(authed_client, project["id"], "C")
    await _lock(authed_client, project["id"], a["id"])
    await _lock(authed_client, project["id"], c["id"])

    response = await authed_client.post(f"/api/v1/projects/{project['id']}/outline/unlock-all")
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["total"] == 3
    assert {item["id"] for item in page["items"]} == {a["id"], b["id"], c["id"]}
    assert all(item["contentLocked"] is False for item in page["items"])
    # Content itself is untouched - only the flag is cleared.
    assert next(item for item in page["items"] if item["id"] == a["id"])["contentMarkdown"] == CURATED

    again = await authed_client.post(f"/api/v1/projects/{project['id']}/outline/unlock-all")
    assert again.status_code == 200, again.text
    assert all(item["contentLocked"] is False for item in again.json()["items"])

    missing = await authed_client.post(f"/api/v1/projects/{uuid.uuid4()}/outline/unlock-all")
    assert missing.status_code == 404


async def test_duplicate_project_keeps_locks_along_with_the_copied_content(
    authed_client: AsyncClient,
) -> None:
    project = await _create_project(authed_client)
    node = await _create_node(authed_client, project["id"], "A")
    await _lock(authed_client, project["id"], node["id"])

    response = await authed_client.post(f"/api/v1/projects/{project['id']}/duplicate")
    assert response.status_code == 201, response.text
    copy = response.json()
    outline = await authed_client.get(f"/api/v1/projects/{copy['id']}/outline")
    assert outline.status_code == 200
    [copied] = outline.json()["items"]
    assert copied["contentMarkdown"] == CURATED
    assert copied["contentLocked"] is True


# ---------------------------------------------------------------------------
# StructureBuilder / work dir
# ---------------------------------------------------------------------------


def test_structure_builder_emits_lock_keys_only_when_asked_and_only_for_locked_leaves() -> None:
    project = _make_project()
    locked_leaf = _make_node(title="Kept", content_locked=True, content_markdown=CURATED, cli_key="1")
    blank_locked = _make_node(title="Blank", content_locked=True, content_markdown="  ", cli_key="2")
    plain = _make_node(title="Plain", cli_key="3")
    locked_parent = _make_node(title="Parent", content_locked=True, content_markdown=CURATED, cli_key="4")
    child = _make_node(title="Child", cli_key="4-1", level=2, section_number="4.1")
    tree = [
        OutlineTree(node=locked_leaf, children=[]),
        OutlineTree(node=blank_locked, children=[]),
        OutlineTree(node=plain, children=[]),
        OutlineTree(node=locked_parent, children=[OutlineTree(node=child, children=[])]),
    ]

    # Default (what `GET /spec?format=json` uses): never.
    built = StructureBuilder.build(project, tree, lock_nodes=True)
    assert all("content_locked" not in ch and "content_file" not in ch for ch in built["childs"])

    built = StructureBuilder.build(project, tree, lock_nodes=False, include_locked_content=True)
    kept, blank, plain_out, parent_out = built["childs"]
    assert kept["content_locked"] is True
    assert kept["structure_locked"] is True  # implied even with lock_nodes=False
    assert kept["content_file"] == f"locked_sections/{locked_leaf.id}.md"
    for other in (blank, plain_out, parent_out, parent_out["childs"][0]):
        assert "content_locked" not in other
        assert "content_file" not in other
    assert "structure_locked" not in plain_out

    assert locked_section_files(tree) == {f"locked_sections/{locked_leaf.id}.md": CURATED}


async def test_spec_json_download_never_carries_lock_keys(authed_client: AsyncClient) -> None:
    project = await _create_project(authed_client)
    node = await _create_node(authed_client, project["id"], "Kept")
    await _lock(authed_client, project["id"], node["id"])

    response = await authed_client.get(f"/api/v1/projects/{project['id']}/spec", params={"format": "json"})
    assert response.status_code == 200, response.text
    [child] = response.json()["childs"]
    assert child["structure_locked"] is True
    assert "content_locked" not in child
    assert "content_file" not in child


async def test_prepare_work_dir_writes_locked_section_files_for_project_outline_runs(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        repo = SqlAlchemyOutlineRepository(session)
        locked = await repo.add(
            _make_node(project_id=project.id, order_index=0, title="Kept", content_locked=True, content_markdown=CURATED)
        )
        await repo.add(_make_node(project_id=project.id, order_index=1, title="Fresh"))
        tree = build_tree(await repo.list(project.id))
        service = _make_service(session, InMemoryFileStorage(), _worker_settings())

        work_dir = tmp_path / "run"
        run = _make_run(project.id, work_dir, options=RunOptions(outline="project", output_format="markdown"))
        await service._prepare_work_dir(run, project, tree)

        structure = json.loads((work_dir / "out" / "book_structure.json").read_text(encoding="utf-8"))
        kept, fresh = structure["childs"]
        assert kept["content_locked"] is True
        assert kept["content_file"] == f"locked_sections/{locked.id}.md"
        assert "content_locked" not in fresh
        assert (work_dir / "out" / kept["content_file"]).read_text(encoding="utf-8") == CURATED

        # `generate` sends no outline at all - nothing to lock.
        other_dir = tmp_path / "generate-run"
        run = _make_run(project.id, other_dir, options=RunOptions(outline="generate", output_format="markdown"))
        await service._prepare_work_dir(run, project, tree)
        assert not (other_dir / "out" / "book_structure.json").exists()
        assert not (other_dir / "out" / "locked_sections").exists()


# ---------------------------------------------------------------------------
# Import back
# ---------------------------------------------------------------------------


async def test_import_graph_never_overwrites_a_locked_nodes_content(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        repo = SqlAlchemyOutlineRepository(session)
        locked = await repo.add(
            _make_node(
                project_id=project.id, order_index=0, title="Old Title",
                content_locked=True, content_markdown=CURATED, cli_key=None,
            )
        )
        fresh = await repo.add(_make_node(project_id=project.id, order_index=1, title="Fresh", cli_key=None))

        work_dir = tmp_path / "run"
        out_dir = work_dir / "out"
        (out_dir / "sections").mkdir(parents=True)
        # A truncated copy - exactly what must not win over the DB row.
        (out_dir / "sections" / "1.md").write_text("## Kept\n\nCur", encoding="utf-8")
        (out_dir / "sections" / "2.md").write_text("## Fresh\n\nGenerated body.\n", encoding="utf-8")
        _write_structure_graph(
            out_dir,
            nodes={
                "book": {},
                "1": {"title": "New Title", "summary": "New summary", "n_pages": 3.0, "content_locked": True},
                "2": {"title": "Fresh", "summary": "", "n_pages": 1.0},
            },
            edges=[["book", "1"], ["book", "2"]],
        )

        await import_graph(project, work_dir, repo, SqlAlchemySourceRepository(session))

        kept = await repo.get(locked.id)
        regenerated = await repo.get(fresh.id)

    assert kept is not None and regenerated is not None
    assert kept.content_markdown == CURATED
    assert kept.content_locked is True
    # Structure-side sync still happens for the locked row.
    assert kept.title == "New Title"
    assert kept.target_pages == 3.0
    assert regenerated.content_markdown == "## Fresh\n\nGenerated body.\n"


async def test_full_run_keeps_locked_content_end_to_end(
    app,
    authed_client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    """The fake CLI ignores `content_locked` and writes its own text for
    every leaf, so this pins the API side of the guarantee: the DB row of a
    locked chapter is byte-identical after a full run while its unlocked
    sibling is regenerated."""
    settings = _settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings
    project = await _create_project(authed_client)
    kept = await _create_node(authed_client, project["id"], "Kept")
    fresh = await _create_node(authed_client, project["id"], "Fresh")

    await _run_full(authed_client, project["id"], session_factory, file_storage, settings)
    await _lock(authed_client, project["id"], kept["id"])
    await _patch(authed_client, project["id"], fresh["id"], {"contentMarkdown": "Will be regenerated."})

    await _run_full(authed_client, project["id"], session_factory, file_storage, settings)

    kept_after = await _get_node(authed_client, project["id"], kept["id"])
    fresh_after = await _get_node(authed_client, project["id"], fresh["id"])
    assert kept_after["contentMarkdown"] == CURATED
    assert kept_after["contentLocked"] is True
    assert "Fake generated content" in fresh_after["contentMarkdown"]

    # And the second run's work dir actually shipped the locked text to the CLI.
    locked_files = list(Path(settings.runs_dir).rglob(f"locked_sections/{kept['id']}.md"))
    assert locked_files, "no locked_sections file written into any run work dir"
    assert all(path.read_text(encoding="utf-8") == CURATED for path in locked_files)


# ---------------------------------------------------------------------------
# Run guards
# ---------------------------------------------------------------------------


async def test_regenerate_409_on_a_locked_node_but_a_lock_toggle_alone_never_409s(
    app,
    authed_client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings
    project = await _create_project(authed_client)
    a = await _create_node(authed_client, project["id"], "A")
    b = await _create_node(authed_client, project["id"], "B")
    await _run_full(authed_client, project["id"], session_factory, file_storage, settings)

    # Locking B (and un/re-locking A) changes nothing the drift check hashes.
    await _lock(authed_client, project["id"], b["id"])
    await _lock(authed_client, project["id"], a["id"])
    response = await _patch(authed_client, project["id"], a["id"], {"contentLocked": False})
    assert response.status_code == 200, response.text

    regenerate_a = await authed_client.post(
        f"/api/v1/projects/{project['id']}/outline/{a['id']}/regenerate", json={}
    )
    assert regenerate_a.status_code == 202, regenerate_a.text

    # B is locked: regenerating it is refused and its status is untouched.
    b_before = await _get_node(authed_client, project["id"], b["id"])
    regenerate_b = await authed_client.post(
        f"/api/v1/projects/{project['id']}/outline/{b['id']}/regenerate", json={}
    )
    assert regenerate_b.status_code == 409, regenerate_b.text
    assert "content-locked" in regenerate_b.json()["detail"]
    b_after = await _get_node(authed_client, project["id"], b["id"])
    assert b_after["status"] == b_before["status"]


async def test_legacy_tex_422_when_any_node_is_locked(authed_client: AsyncClient) -> None:
    project = await _create_project(authed_client)
    node = await _create_node(authed_client, project["id"], "Kept")

    unlocked = await authed_client.post(
        f"/api/v1/projects/{project['id']}/runs",
        json={"outline": "project", "outputFormat": "latex", "legacyTex": True},
    )
    assert unlocked.status_code == 202, unlocked.text
    cancel = await authed_client.post(f"/api/v1/runs/{unlocked.json()['id']}/cancel")
    assert cancel.status_code in (200, 202, 204), cancel.text

    await _lock(authed_client, project["id"], node["id"])
    locked = await authed_client.post(
        f"/api/v1/projects/{project['id']}/runs",
        json={"outline": "project", "outputFormat": "latex", "legacyTex": True},
    )
    assert locked.status_code == 422, locked.text
    assert "content-locked" in locked.json()["detail"]

    # Without legacyTex the same project runs fine.
    plain = await authed_client.post(f"/api/v1/projects/{project['id']}/runs", json={"outline": "project"})
    assert plain.status_code == 202, plain.text


# ---------------------------------------------------------------------------
# Review follow-ups
# ---------------------------------------------------------------------------


async def test_no_sections_can_be_added_or_moved_under_a_locked_leaf(authed_client: AsyncClient) -> None:
    project = await _create_project(authed_client)
    kept = await _create_node(authed_client, project["id"], "Kept")
    other = await _create_node(authed_client, project["id"], "Other")
    await _lock(authed_client, project["id"], kept["id"])

    created = await authed_client.post(
        f"/api/v1/projects/{project['id']}/outline", json={"title": "Child", "parentId": kept["id"]}
    )
    assert created.status_code == 409, created.text
    assert "content-locked" in created.json()["detail"]

    moved = await _patch(authed_client, project["id"], other["id"], {"parentId": kept["id"]})
    assert moved.status_code == 409, moved.text

    # Still a leaf, still locked.
    outline = await authed_client.get(f"/api/v1/projects/{project['id']}/outline")
    assert [n["parentId"] for n in outline.json()["items"]] == [None, None]
    assert (await _get_node(authed_client, project["id"], kept["id"]))["contentLocked"] is True


def test_sync_content_locks_into_graph_follows_the_outline_not_the_base_run() -> None:
    unlocked_since = _make_node(title="Was locked", content_markdown=CURATED, cli_key="1")
    locked_since = _make_node(title="Now locked", content_locked=True, content_markdown="New text", cli_key="2")
    parent = _make_node(title="Parent", content_locked=True, content_markdown=CURATED, cli_key="3")
    child = _make_node(title="Child", parent_id=parent.id, cli_key="3-1", level=2, section_number="3.1")
    graph = {
        "nodes": {
            "book": {},
            "1": {"title": "Was locked", "content_locked": True, "content_file": f"locked_sections/{unlocked_since.id}.md"},
            "2": {"title": "Now locked"},
            "3": {"title": "Parent"},
            "3-1": {"title": "Child"},
        },
        "edges": [["book", "1"], ["book", "2"], ["book", "3"], ["3", "3-1"]],
    }

    changed, files, stale = sync_content_locks_into_graph(graph, [unlocked_since, locked_since, parent, child])

    assert changed is True
    assert "content_locked" not in graph["nodes"]["1"] and "content_file" not in graph["nodes"]["1"]
    assert stale == [f"locked_sections/{unlocked_since.id}.md"]
    assert graph["nodes"]["2"]["content_locked"] is True
    assert graph["nodes"]["2"]["structure_locked"] is True
    assert graph["nodes"]["2"]["content_file"] == f"locked_sections/{locked_since.id}.md"
    assert files == {f"locked_sections/{locked_since.id}.md": "New text"}
    # A locked node with children is not a lock the CLI can honour.
    assert "content_locked" not in graph["nodes"]["3"]

    # Idempotent.
    assert sync_content_locks_into_graph(graph, [unlocked_since, locked_since, parent, child])[0] is False


async def test_regenerate_after_unlocking_actually_regenerates(
    app,
    authed_client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    """The regenerate path reuses the base run's structure_graph.json, whose node still says
    content_locked from when the base run started; without syncing the outline's current
    locks into it the CLI would re-copy the old text and the regenerate would be a no-op."""
    settings = _settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings
    project = await _create_project(authed_client)
    kept = await _create_node(authed_client, project["id"], "Kept")
    await _create_node(authed_client, project["id"], "Other")

    # Base run with `kept` locked -> its graph node carries content_locked + content_file.
    await _lock(authed_client, project["id"], kept["id"])
    base = await _run_full(authed_client, project["id"], session_factory, file_storage, settings)
    graph_path = Path(settings.runs_dir) / base["id"] / "out" / "structure_graph.json"
    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    kept_key = (await _get_node(authed_client, project["id"], kept["id"]))["cliKey"]
    assert graph["nodes"][kept_key]["content_locked"] is True

    # Unlock, regenerate, drive it.
    response = await _patch(authed_client, project["id"], kept["id"], {"contentLocked": False})
    assert response.status_code == 200, response.text
    regenerate = await authed_client.post(
        f"/api/v1/projects/{project['id']}/outline/{kept['id']}/regenerate", json={}
    )
    assert regenerate.status_code == 202, regenerate.text
    finished = await _drive_generation(regenerate.json()["id"], session_factory, file_storage, settings)
    assert finished.status.value == "succeeded", finished.error

    graph = json.loads(graph_path.read_text(encoding="utf-8"))
    assert "content_locked" not in graph["nodes"][kept_key]
    assert "content_file" not in graph["nodes"][kept_key]
    assert not (graph_path.parent / "locked_sections" / f"{kept['id']}.md").exists()
    after = await _get_node(authed_client, project["id"], kept["id"])
    assert after["contentMarkdown"] != CURATED
    assert "Fake generated content" in after["contentMarkdown"]


async def test_unlock_all_on_run_creation_is_atomic_with_admission(
    app,
    authed_client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path, max_queued_runs_per_project=1)
    app.dependency_overrides[get_settings] = lambda: settings
    project = await _create_project(authed_client)
    kept = await _create_node(authed_client, project["id"], "Kept")
    await _lock(authed_client, project["id"], kept["id"])

    # Fill the lane so the next creation is rejected: the lock must survive that.
    first = await authed_client.post(f"/api/v1/projects/{project['id']}/runs", json={"outline": "project"})
    assert first.status_code == 202, first.text
    rejected = await authed_client.post(
        f"/api/v1/projects/{project['id']}/runs", json={"outline": "project", "unlockAll": True}
    )
    assert rejected.status_code == 409, rejected.text
    assert (await _get_node(authed_client, project["id"], kept["id"]))["contentLocked"] is True

    # legacyTex + unlockAll is fine: the locks are gone by the time the run starts.
    cancel = await authed_client.post(f"/api/v1/runs/{first.json()['id']}/cancel")
    assert cancel.status_code in (200, 202, 204), cancel.text
    accepted = await authed_client.post(
        f"/api/v1/projects/{project['id']}/runs",
        json={"outline": "project", "outputFormat": "latex", "legacyTex": True, "unlockAll": True},
    )
    assert accepted.status_code == 202, accepted.text
    assert "unlockAll" not in accepted.json()["options"]
    assert (await _get_node(authed_client, project["id"], kept["id"]))["contentLocked"] is False
