from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.core.errors import NotFound
from api.domain.models import MathLevel, NodeStatus, OutlineNode, Run, RunKind, RunOptions, RunStatus
from api.infrastructure.db.models import OutlineNodeRecord
from api.infrastructure.db.outline_repository import SqlAlchemyOutlineRepository
from api.infrastructure.db.run_repository import SqlAlchemyRunRepository

MINIMAL_PROJECT = {
    "title": "Intro to Widgets",
    "subtitle": "A Practical Guide",
    "authors": ["Ada Lovelace"],
    "topic": "widgets",
}


async def _create_project(client: AsyncClient, **overrides) -> dict:
    payload = {**MINIMAL_PROJECT, **overrides}
    response = await client.post("/api/v1/projects", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def _create_node(client: AsyncClient, project_id: str, **overrides) -> dict:
    payload = {"title": "Untitled", "parentId": None, **overrides}
    response = await client.post(f"/api/v1/projects/{project_id}/outline", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _domain_node(
    project_id: uuid.UUID, parent_id: uuid.UUID | None, order_index: int, **overrides
) -> OutlineNode:
    now = datetime.now(timezone.utc)
    defaults = dict(
        id=uuid.uuid4(),
        project_id=project_id,
        parent_id=parent_id,
        order_index=order_index,
        title="Untitled",
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


async def test_create_chapter_and_subsections_yields_expected_numbers_and_keys(
    client: AsyncClient,
) -> None:
    project = await _create_project(client)
    project_id = project["id"]

    chapter1 = await _create_node(client, project_id, title="Chapter 1")
    chapter2 = await _create_node(client, project_id, title="Chapter 2")
    section11 = await _create_node(
        client, project_id, title="Section 1.1", parentId=chapter1["id"]
    )
    section12 = await _create_node(
        client, project_id, title="Section 1.2", parentId=chapter1["id"]
    )

    assert (chapter1["sectionNumber"], chapter1["cliKey"], chapter1["level"]) == ("1", "1", 1)
    assert (section11["sectionNumber"], section11["cliKey"], section11["level"]) == (
        "1.1",
        "1-1",
        2,
    )
    assert (section12["sectionNumber"], section12["cliKey"], section12["level"]) == (
        "1.2",
        "1-2",
        2,
    )
    assert (chapter2["sectionNumber"], chapter2["cliKey"], chapter2["level"]) == ("2", "2", 1)


async def test_create_node_applies_defaults(client: AsyncClient) -> None:
    project = await _create_project(client, equationFrequencyLevel=2)

    node = await _create_node(client, project["id"], title="Chapter 1")

    assert node["targetPages"] == 1
    assert node["wordBudget"] == 350
    assert node["equationDensityLevel"] == 2
    assert node["mathLevel"] == "rigorous"
    assert node["status"] == "not_started"
    assert node["actualWords"] == 0
    assert node["contentMarkdown"] == ""
    assert node["structureLocked"] is True
    assert node["orderIndex"] == 0


async def test_create_node_appends_order_index_by_default(client: AsyncClient) -> None:
    project = await _create_project(client)
    first = await _create_node(client, project["id"], title="First")
    second = await _create_node(client, project["id"], title="Second")

    assert first["orderIndex"] == 0
    assert second["orderIndex"] == 1


async def test_create_node_with_explicit_order_index_shifts_existing_siblings(
    client: AsyncClient,
) -> None:
    """issue #67: `POST /outline` used to write a caller-supplied
    `orderIndex` verbatim. Under a real parent, inserting a second child at
    an already-occupied position used to raise a raw `IntegrityError` from
    `uq_outline_nodes_project_parent_order`, surfaced as a generic 500 -
    it must instead shift the existing sibling(s) out of the way, the same
    way `PATCH .../outline/{id}` already does."""
    project = await _create_project(client)
    project_id = project["id"]
    parent = await _create_node(client, project_id, title="Parent")
    first = await _create_node(client, project_id, title="First", parentId=parent["id"])
    second = await _create_node(client, project_id, title="Second", parentId=parent["id"])
    assert (first["orderIndex"], second["orderIndex"]) == (0, 1)

    response = await client.post(
        f"/api/v1/projects/{project_id}/outline",
        json={"title": "Inserted", "parentId": parent["id"], "orderIndex": 0},
    )
    assert response.status_code == 201, response.text
    inserted = response.json()
    assert inserted["orderIndex"] == 0

    list_response = await client.get(f"/api/v1/projects/{project_id}/outline")
    by_id = {n["id"]: n for n in list_response.json()["items"]}
    assert by_id[inserted["id"]]["orderIndex"] == 0
    assert by_id[first["id"]]["orderIndex"] == 1
    assert by_id[second["id"]]["orderIndex"] == 2


async def test_create_node_with_explicit_order_index_at_root_never_duplicates_positions(
    client: AsyncClient,
) -> None:
    """issue #67: at root level (`parentId: null`), the same unchecked-write
    bug didn't even raise - both SQLite and Postgres treat `NULL` as
    distinct in the (`project_id`, `parent_id`, `order_index`) unique index
    by default, so two live root nodes could silently end up sharing
    `order_index: 0`, making the outline order (and the `sectionNumber`/
    `cliKey` derived from it) nondeterministic. Creating with an explicit
    `orderIndex` at root must shift existing root siblings instead."""
    project = await _create_project(client)
    project_id = project["id"]
    first = await _create_node(client, project_id, title="First")
    second = await _create_node(client, project_id, title="Second")
    assert (first["orderIndex"], second["orderIndex"]) == (0, 1)

    response = await client.post(
        f"/api/v1/projects/{project_id}/outline",
        json={"title": "Inserted", "orderIndex": 0},
    )
    assert response.status_code == 201, response.text
    inserted = response.json()

    list_response = await client.get(f"/api/v1/projects/{project_id}/outline")
    items = list_response.json()["items"]
    order_indexes = sorted(n["orderIndex"] for n in items)
    assert order_indexes == [0, 1, 2]
    by_id = {n["id"]: n for n in items}
    assert by_id[inserted["id"]]["orderIndex"] == 0
    assert by_id[first["id"]]["orderIndex"] == 1
    assert by_id[second["id"]]["orderIndex"] == 2


async def test_create_node_rejects_out_of_range_order_index_with_422(
    client: AsyncClient,
) -> None:
    project = await _create_project(client)
    project_id = project["id"]
    await _create_node(client, project_id, title="Only")

    response = await client.post(
        f"/api/v1/projects/{project_id}/outline",
        json={"title": "TooFar", "orderIndex": 5},
    )
    assert response.status_code == 422
    assert response.headers["content-type"] == "application/problem+json"

    negative_response = await client.post(
        f"/api/v1/projects/{project_id}/outline",
        json={"title": "Negative", "orderIndex": -1},
    )
    assert negative_response.status_code == 422


async def test_outline_repository_add_translates_order_collision_into_409(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Backstop for a concurrent write racing past `OutlineService.create`'s
    own check-then-shift logic (issue #67) - a real
    `uq_outline_nodes_project_parent_order` collision at the repository
    layer must come back as `Conflict` (409), not bubble up as a raw,
    unhandled `IntegrityError` (generic 500). Uses a real (non-root)
    `parent_id` so the collision is caught by both backends' default unique
    index semantics, not just Postgres's `NULLS NOT DISTINCT` (which only
    covers the root/`parent_id IS NULL` case, and which SQLite - the test
    suite's default backend - doesn't support at all)."""
    from api.core.errors import Conflict
    from api.infrastructure.db.repositories import SqlAlchemyProjectRepository

    async with session_factory() as session:
        project_repo = SqlAlchemyProjectRepository(session)
        outline_repo = SqlAlchemyOutlineRepository(session)

        project = await project_repo.add(
            _domain_project_for_outline_repo_test()
        )
        parent = await outline_repo.add(_domain_node(project.id, None, 0))
        await outline_repo.add(_domain_node(project.id, parent.id, 0))

        with pytest.raises(Conflict):
            await outline_repo.add(_domain_node(project.id, parent.id, 0))


def _domain_project_for_outline_repo_test():
    from api.domain.models import OutputFormat, Project, TargetAudience

    now = datetime.now(timezone.utc)
    return Project(
        id=uuid.uuid4(),
        owner_id=None,
        title="Repo Test",
        subtitle="Subtitle",
        authors=["Author"],
        topic="topic",
        target_audience=TargetAudience.GRADUATE,
        total_pages_budget=100,
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


async def test_create_node_depth_limit_rejected_with_422(client: AsyncClient) -> None:
    project = await _create_project(client, maxOutlineLevels=3)
    project_id = project["id"]

    level1 = await _create_node(client, project_id, title="L1")
    level2 = await _create_node(client, project_id, title="L2", parentId=level1["id"])
    level3 = await _create_node(client, project_id, title="L3", parentId=level2["id"])

    response = await client.post(
        f"/api/v1/projects/{project_id}/outline",
        json={"title": "L4", "parentId": level3["id"]},
    )

    assert response.status_code == 422
    assert response.headers["content-type"] == "application/problem+json"


async def test_create_node_rejects_blank_title_with_422(client: AsyncClient) -> None:
    """Regression for issue #61: `title=""`/`"   "` used to be accepted
    silently by `OutlineNodeCreate` instead of a 422."""
    project = await _create_project(client)
    project_id = project["id"]

    empty = await client.post(
        f"/api/v1/projects/{project_id}/outline", json={"title": ""}
    )
    blank = await client.post(
        f"/api/v1/projects/{project_id}/outline", json={"title": "   "}
    )

    assert empty.status_code == 422
    assert blank.status_code == 422


async def test_replace_outline_rejects_blank_node_title(client: AsyncClient) -> None:
    project = await _create_project(client)

    response = await client.put(
        f"/api/v1/projects/{project['id']}/outline", json=[{"title": ""}]
    )

    assert response.status_code == 422


async def test_create_node_missing_parent_404s(client: AsyncClient) -> None:
    project = await _create_project(client)

    response = await client.post(
        f"/api/v1/projects/{project['id']}/outline",
        json={"title": "Orphan", "parentId": str(uuid.uuid4())},
    )

    assert response.status_code == 404


async def test_get_and_list_flat_and_tree(client: AsyncClient) -> None:
    project = await _create_project(client)
    project_id = project["id"]
    chapter = await _create_node(client, project_id, title="Chapter 1")
    section = await _create_node(client, project_id, title="Section 1.1", parentId=chapter["id"])

    get_response = await client.get(f"/api/v1/projects/{project_id}/outline/{section['id']}")
    assert get_response.status_code == 200
    assert get_response.json()["title"] == "Section 1.1"

    flat_response = await client.get(f"/api/v1/projects/{project_id}/outline")
    assert flat_response.status_code == 200
    flat_body = flat_response.json()
    assert flat_body["total"] == 2
    assert {item["id"] for item in flat_body["items"]} == {chapter["id"], section["id"]}
    assert all("children" not in item for item in flat_body["items"])

    tree_response = await client.get(
        f"/api/v1/projects/{project_id}/outline", params={"format": "tree"}
    )
    assert tree_response.status_code == 200
    tree_body = tree_response.json()
    assert tree_body["total"] == 2
    assert len(tree_body["items"]) == 1
    root = tree_body["items"][0]
    assert root["id"] == chapter["id"]
    assert len(root["children"]) == 1
    assert root["children"][0]["id"] == section["id"]


async def test_get_node_404_is_problem_json(client: AsyncClient) -> None:
    project = await _create_project(client)

    response = await client.get(
        f"/api/v1/projects/{project['id']}/outline/{uuid.uuid4()}"
    )

    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"


async def test_list_outline_404_when_project_missing(client: AsyncClient) -> None:
    response = await client.get(f"/api/v1/projects/{uuid.uuid4()}/outline")

    assert response.status_code == 404


async def test_patch_content_markdown_recomputes_actual_words(client: AsyncClient) -> None:
    project = await _create_project(client)
    node = await _create_node(client, project["id"], title="Chapter 1")

    response = await client.patch(
        f"/api/v1/projects/{project['id']}/outline/{node['id']}",
        json={"contentMarkdown": "one two three four five"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["contentMarkdown"] == "one two three four five"
    assert body["actualWords"] == 5


async def test_patch_rejects_server_derived_fields(client: AsyncClient) -> None:
    project = await _create_project(client)
    node = await _create_node(client, project["id"], title="Chapter 1")

    for field, value in [
        ("level", 3),
        ("sectionNumber", "9.9"),
        ("cliKey", "9-9"),
        ("actualWords", 42),
    ]:
        response = await client.patch(
            f"/api/v1/projects/{project['id']}/outline/{node['id']}",
            json={field: value},
        )
        assert response.status_code == 422, field
        assert response.headers["content-type"] == "application/problem+json"


async def test_patch_rename_and_status(client: AsyncClient) -> None:
    project = await _create_project(client)
    node = await _create_node(client, project["id"], title="Draft title")

    response = await client.patch(
        f"/api/v1/projects/{project['id']}/outline/{node['id']}",
        json={"title": "Final title", "status": "drafting"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "Final title"
    assert body["status"] == "drafting"


async def test_patch_target_pages_recomputes_word_budget(client: AsyncClient) -> None:
    """Regression for issue #68: `wordBudget` was only ever derived from
    `targetPages` at node-creation time - a later `PATCH .../outline/{id}`
    changing `targetPages` left `wordBudget` stale relative to it."""
    project = await _create_project(client)
    node = await _create_node(client, project["id"], title="Chapter 1", targetPages=2)
    assert node["wordBudget"] == 700

    response = await client.patch(
        f"/api/v1/projects/{project['id']}/outline/{node['id']}",
        json={"targetPages": 4},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["targetPages"] == 4
    assert body["wordBudget"] == 1400


async def test_patch_explicit_word_budget_alongside_target_pages_is_kept(
    client: AsyncClient,
) -> None:
    """An explicit `wordBudget` sent in the same `PATCH` as `targetPages`
    must win over the derived value, not be clobbered by it (issue #68)."""
    project = await _create_project(client)
    node = await _create_node(client, project["id"], title="Chapter 1", targetPages=2)

    response = await client.patch(
        f"/api/v1/projects/{project['id']}/outline/{node['id']}",
        json={"targetPages": 4, "wordBudget": 999},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["targetPages"] == 4
    assert body["wordBudget"] == 999


async def test_patch_toggles_structure_locked(client: AsyncClient) -> None:
    project = await _create_project(client)
    node = await _create_node(client, project["id"], title="Chapter 1")
    assert node["structureLocked"] is True

    response = await client.patch(
        f"/api/v1/projects/{project['id']}/outline/{node['id']}",
        json={"structureLocked": False},
    )

    assert response.status_code == 200
    assert response.json()["structureLocked"] is False


async def test_move_node_between_parents_updates_positions(client: AsyncClient) -> None:
    project = await _create_project(client)
    project_id = project["id"]
    chapter1 = await _create_node(client, project_id, title="Chapter 1")
    chapter2 = await _create_node(client, project_id, title="Chapter 2")
    section = await _create_node(
        client, project_id, title="Section", parentId=chapter1["id"]
    )
    assert section["cliKey"] == "1-1"

    response = await client.patch(
        f"/api/v1/projects/{project_id}/outline/{section['id']}",
        json={"parentId": chapter2["id"]},
    )

    assert response.status_code == 200
    moved = response.json()
    assert moved["parentId"] == chapter2["id"]
    assert moved["cliKey"] == "2-1"
    assert moved["sectionNumber"] == "2.1"

    # Old parent (chapter1) has no children left; new parent (chapter2) does.
    tree_response = await client.get(
        f"/api/v1/projects/{project_id}/outline", params={"format": "tree"}
    )
    tree_by_id = {node["id"]: node for node in tree_response.json()["items"]}
    assert tree_by_id[chapter1["id"]]["children"] == []
    assert [c["id"] for c in tree_by_id[chapter2["id"]]["children"]] == [section["id"]]


async def test_move_node_rejects_move_into_own_subtree(client: AsyncClient) -> None:
    project = await _create_project(client)
    project_id = project["id"]
    parent = await _create_node(client, project_id, title="Parent")
    child = await _create_node(client, project_id, title="Child", parentId=parent["id"])

    response = await client.patch(
        f"/api/v1/projects/{project_id}/outline/{parent['id']}",
        json={"parentId": child["id"]},
    )

    assert response.status_code == 422


async def test_move_node_rejects_move_exceeding_max_outline_levels(
    client: AsyncClient,
) -> None:
    project = await _create_project(client, maxOutlineLevels=2)
    project_id = project["id"]
    chapter_a = await _create_node(client, project_id, title="A")
    chapter_b = await _create_node(client, project_id, title="B")
    grandchild_host = await _create_node(
        client, project_id, title="B.1", parentId=chapter_b["id"]
    )

    # Moving chapter_a (which has no children) under grandchild_host would put
    # it at depth 3 on a maxOutlineLevels=2 project.
    response = await client.patch(
        f"/api/v1/projects/{project_id}/outline/{chapter_a['id']}",
        json={"parentId": grandchild_host["id"]},
    )

    assert response.status_code == 422


async def test_reorder_within_same_parent(client: AsyncClient) -> None:
    project = await _create_project(client)
    project_id = project["id"]
    first = await _create_node(client, project_id, title="First")
    second = await _create_node(client, project_id, title="Second")

    response = await client.patch(
        f"/api/v1/projects/{project_id}/outline/{second['id']}",
        json={"orderIndex": 0},
    )

    assert response.status_code == 200
    assert response.json()["orderIndex"] == 0

    flat_response = await client.get(f"/api/v1/projects/{project_id}/outline")
    by_id = {n["id"]: n for n in flat_response.json()["items"]}
    assert by_id[second["id"]]["orderIndex"] == 0
    assert by_id[first["id"]]["orderIndex"] == 1
    assert by_id[second["id"]]["sectionNumber"] == "1"
    assert by_id[first["id"]]["sectionNumber"] == "2"


async def test_update_node_404(client: AsyncClient) -> None:
    project = await _create_project(client)

    response = await client.patch(
        f"/api/v1/projects/{project['id']}/outline/{uuid.uuid4()}",
        json={"title": "Nope"},
    )

    assert response.status_code == 404


async def test_concurrent_updates_to_different_fields_do_not_clobber_each_other(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """Regression for issue #56: two concurrent `PATCH /outline/{nodeId}`
    requests touching different fields (a debounced content autosave racing
    a `structureLocked`/`status` toggle) used to each `list -> replace ->
    write the whole row` - whichever committed last silently reverted the
    other's change. Simulates the exact interleaving that used to corrupt
    this: both "requests" build their write from the *same* baseline row,
    i.e. both read before either wrote."""
    project = await _create_project(client)
    node = await _create_node(client, project["id"], title="Chapter 1")
    node_id = uuid.UUID(node["id"])

    async with session_factory() as session:
        baseline = await SqlAlchemyOutlineRepository(session).get(node_id)
    assert baseline is not None

    from dataclasses import replace as dataclass_replace

    autosave = dataclass_replace(
        baseline,
        content_markdown="draft content",
        actual_words=2,
        updated_at=datetime.now(timezone.utc),
    )
    lock_toggle = dataclass_replace(
        baseline,
        structure_locked=not baseline.structure_locked,
        updated_at=datetime.now(timezone.utc),
    )

    async with session_factory() as session:
        repo = SqlAlchemyOutlineRepository(session)
        await repo.update(autosave, fields=("content_markdown", "actual_words"))
        await repo.update(lock_toggle, fields=("structure_locked",))
        final = await repo.get(node_id)

    assert final is not None
    assert final.content_markdown == "draft content"
    assert final.structure_locked == (not baseline.structure_locked)


async def test_delete_node_soft_deletes_subtree(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    project = await _create_project(client)
    project_id = project["id"]
    chapter = await _create_node(client, project_id, title="Chapter 1")
    section = await _create_node(
        client, project_id, title="Section 1.1", parentId=chapter["id"]
    )
    other_chapter = await _create_node(client, project_id, title="Chapter 2")

    delete_response = await client.delete(
        f"/api/v1/projects/{project_id}/outline/{chapter['id']}"
    )
    assert delete_response.status_code == 204

    # Gone from listings/tree building and direct GET...
    flat_response = await client.get(f"/api/v1/projects/{project_id}/outline")
    remaining_ids = {n["id"] for n in flat_response.json()["items"]}
    assert remaining_ids == {other_chapter["id"]}

    get_deleted = await client.get(
        f"/api/v1/projects/{project_id}/outline/{section['id']}"
    )
    assert get_deleted.status_code == 404

    # ...but the rows themselves still exist, with `deleted_at` set (soft
    # delete, not a SQL DELETE) - `other_chapter` is untouched.
    async with session_factory() as session:
        chapter_record = await session.get(OutlineNodeRecord, uuid.UUID(chapter["id"]))
        section_record = await session.get(OutlineNodeRecord, uuid.UUID(section["id"]))
        other_record = await session.get(
            OutlineNodeRecord, uuid.UUID(other_chapter["id"])
        )

    assert chapter_record is not None
    assert chapter_record.deleted_at is not None
    assert section_record is not None
    assert section_record.deleted_at is not None
    assert other_record is not None
    assert other_record.deleted_at is None


async def test_delete_node_404(client: AsyncClient) -> None:
    project = await _create_project(client)

    response = await client.delete(
        f"/api/v1/projects/{project['id']}/outline/{uuid.uuid4()}"
    )

    assert response.status_code == 404


async def test_outline_reads_survive_a_live_node_under_a_soft_deleted_parent(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """Reproduces issue #75 directly: a child left live under a
    soft-deleted parent (the state a `POST /outline` racing a `DELETE
    /outline/{parent}` used to be able to produce) must not turn every
    outline/project read into a 500."""
    project = await _create_project(client)
    project_id = project["id"]
    chapter = await _create_node(client, project_id, title="Chapter 1")
    section = await _create_node(
        client, project_id, title="Section 1.1", parentId=chapter["id"]
    )

    async with session_factory() as session:
        record = await session.get(OutlineNodeRecord, uuid.UUID(chapter["id"]))
        assert record is not None
        record.deleted_at = datetime.now(timezone.utc)
        await session.commit()

    flat_response = await client.get(f"/api/v1/projects/{project_id}/outline")
    assert flat_response.status_code == 200
    remaining_ids = {n["id"] for n in flat_response.json()["items"]}
    assert remaining_ids == {section["id"]}

    project_response = await client.get(f"/api/v1/projects/{project_id}")
    assert project_response.status_code == 200


async def test_repository_add_rejects_a_node_under_a_soft_deleted_parent(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """Repository-level guard for issue #75's other race (`POST /outline`
    racing a concurrent `DELETE /outline/{parent}`): calling `add()` on a
    parent that's already soft-deleted must raise `NotFound`, whether or
    not a caller's own (necessarily earlier-read) snapshot still thought it
    was live - `OutlineService.create` already rejects this using its own
    snapshot, so exercise the repository directly to isolate this second,
    independent check."""
    project = await _create_project(client)
    project_id = uuid.UUID(project["id"])
    chapter = await _create_node(client, str(project_id), title="Chapter 1")
    chapter_id = uuid.UUID(chapter["id"])

    async with session_factory() as session:
        record = await session.get(OutlineNodeRecord, chapter_id)
        assert record is not None
        record.deleted_at = datetime.now(timezone.utc)
        await session.commit()

        with pytest.raises(NotFound):
            await SqlAlchemyOutlineRepository(session).add(
                _domain_node(project_id, chapter_id, 0, title="Section 1.1")
            )


async def test_repository_delete_subtree_recomputes_descendants_at_call_time(
    session_factory: async_sessionmaker[AsyncSession], client: AsyncClient
) -> None:
    """The other half of issue #75's race: `delete_subtree` takes only the
    target node's id (never a caller-supplied descendant list, unlike the
    pre-fix signature) and must find every live descendant itself,
    including ones a caller's own `flat` snapshot could never have known
    about - e.g. a child the worker's `import_graph` inserts, or a second
    `POST /outline`, landing after that snapshot was read but before this
    call runs."""
    project = await _create_project(client)
    project_id = uuid.UUID(project["id"])

    async with session_factory() as session:
        outline_repo = SqlAlchemyOutlineRepository(session)
        chapter = await outline_repo.add(_domain_node(project_id, None, 0, title="Chapter 1"))
        child = await outline_repo.add(
            _domain_node(project_id, chapter.id, 0, title="Section 1.1")
        )
        grandchild = await outline_repo.add(
            _domain_node(project_id, child.id, 0, title="Section 1.1.1")
        )

        await outline_repo.delete_subtree(project_id, chapter.id)

        remaining = await outline_repo.list(project_id)
        assert remaining == []

        deleted_chapter = await session.get(OutlineNodeRecord, chapter.id)
        deleted_child = await session.get(OutlineNodeRecord, child.id)
        deleted_grandchild = await session.get(OutlineNodeRecord, grandchild.id)

    assert deleted_chapter is not None and deleted_chapter.deleted_at is not None
    assert deleted_child is not None and deleted_child.deleted_at is not None
    assert deleted_grandchild is not None and deleted_grandchild.deleted_at is not None


async def test_replace_outline_creates_full_tree_and_returns_flat(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    project = await _create_project(client)
    project_id = project["id"]
    stale = await _create_node(client, project_id, title="Stale node")

    body = [
        {
            "title": "Chapter 1",
            "children": [
                {"title": "Section 1.1"},
                {"title": "Section 1.2", "targetPages": 3},
            ],
        },
        {"title": "Chapter 2"},
    ]

    response = await client.put(f"/api/v1/projects/{project_id}/outline", json=body)

    assert response.status_code == 200
    result = response.json()
    assert result["total"] == 4
    titles_by_key = {n["cliKey"]: n["title"] for n in result["items"]}
    assert titles_by_key == {
        "1": "Chapter 1",
        "1-1": "Section 1.1",
        "1-2": "Section 1.2",
        "2": "Chapter 2",
    }
    section12 = next(n for n in result["items"] if n["cliKey"] == "1-2")
    assert section12["targetPages"] == 3
    assert section12["wordBudget"] == 1050

    # Stale node from before the replace no longer appears via GET...
    flat_response = await client.get(f"/api/v1/projects/{project_id}/outline")
    assert flat_response.json()["total"] == 4

    # ...but, consistent with soft delete everywhere else, its row still
    # exists in the database with `deleted_at` set.
    async with session_factory() as session:
        stale_record = await session.get(OutlineNodeRecord, uuid.UUID(stale["id"]))
    assert stale_record is not None
    assert stale_record.deleted_at is not None


async def test_soft_deleted_siblings_do_not_affect_new_node_positions(
    client: AsyncClient,
) -> None:
    project = await _create_project(client)
    project_id = project["id"]
    await _create_node(client, project_id, title="Chapter 1")
    chapter2 = await _create_node(client, project_id, title="Chapter 2")
    await _create_node(client, project_id, title="Chapter 3")

    delete_response = await client.delete(
        f"/api/v1/projects/{project_id}/outline/{chapter2['id']}"
    )
    assert delete_response.status_code == 204

    await _create_node(client, project_id, title="Chapter 4")

    flat_response = await client.get(f"/api/v1/projects/{project_id}/outline")
    body = flat_response.json()
    assert body["total"] == 3
    by_title = {n["title"]: n for n in body["items"]}
    assert set(by_title) == {"Chapter 1", "Chapter 3", "Chapter 4"}
    # Positions/keys are computed only over the live siblings - no gap for
    # the soft-deleted "Chapter 2".
    assert {n["cliKey"] for n in by_title.values()} == {"1", "2", "3"}


async def test_replace_outline_rejects_depth_exceeding_max_outline_levels(
    client: AsyncClient,
) -> None:
    project = await _create_project(client, maxOutlineLevels=2)

    body = [
        {
            "title": "Chapter 1",
            "children": [
                {"title": "Section 1.1", "children": [{"title": "Subsection 1.1.1"}]}
            ],
        }
    ]

    response = await client.put(
        f"/api/v1/projects/{project['id']}/outline", json=body
    )

    assert response.status_code == 422
    assert response.headers["content-type"] == "application/problem+json"


async def test_replace_outline_with_empty_list_reports_limit_at_least_one(
    client: AsyncClient,
) -> None:
    """Regression for issue #61: this response echoes `limit=len(items)`,
    which used to fall to `limit=0` for an empty outline even though
    `PageParams.limit`'s documented minimum everywhere else is 1."""
    project = await _create_project(client)

    response = await client.put(f"/api/v1/projects/{project['id']}/outline", json=[])

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 0
    assert body["limit"] >= 1


async def test_replace_outline_404_when_project_missing(client: AsyncClient) -> None:
    response = await client.put(
        f"/api/v1/projects/{uuid.uuid4()}/outline", json=[{"title": "Chapter 1"}]
    )

    assert response.status_code == 404


async def test_project_response_embeds_outline_tree(client: AsyncClient) -> None:
    project = await _create_project(client)
    chapter = await _create_node(client, project["id"], title="Chapter 1")
    await _create_node(client, project["id"], title="Section 1.1", parentId=chapter["id"])

    response = await client.get(f"/api/v1/projects/{project['id']}")

    assert response.status_code == 200
    body = response.json()
    assert len(body["outline"]) == 1
    assert body["outline"][0]["title"] == "Chapter 1"
    assert len(body["outline"][0]["children"]) == 1


async def test_project_summary_outline_node_count_is_real(client: AsyncClient) -> None:
    project = await _create_project(client)
    await _create_node(client, project["id"], title="Chapter 1")
    await _create_node(client, project["id"], title="Chapter 2")

    response = await client.get("/api/v1/projects")

    assert response.status_code == 200
    summary = next(p for p in response.json()["items"] if p["id"] == project["id"])
    assert summary["outlineNodeCount"] == 2


async def test_create_project_with_wizard_outline(client: AsyncClient) -> None:
    payload = {
        **MINIMAL_PROJECT,
        "outline": [
            {
                "title": "Chapter 1",
                "children": [{"title": "Section 1.1"}],
            }
        ],
    }

    response = await client.post("/api/v1/projects", json=payload)

    assert response.status_code == 201
    body = response.json()
    assert len(body["outline"]) == 1
    assert body["outline"][0]["title"] == "Chapter 1"
    assert body["outline"][0]["cliKey"] == "1"
    assert body["outline"][0]["children"][0]["cliKey"] == "1-1"


async def test_duplicate_project_deep_copies_outline_with_new_ids(
    client: AsyncClient,
) -> None:
    project = await _create_project(client, title="Original")
    chapter = await _create_node(client, project["id"], title="Chapter 1")
    section = await _create_node(
        client, project["id"], title="Section 1.1", parentId=chapter["id"]
    )

    response = await client.post(f"/api/v1/projects/{project['id']}/duplicate")

    assert response.status_code == 201
    duplicate = response.json()
    assert duplicate["id"] != project["id"]
    assert len(duplicate["outline"]) == 1
    dup_chapter = duplicate["outline"][0]
    assert dup_chapter["title"] == "Chapter 1"
    assert dup_chapter["id"] != chapter["id"]
    assert dup_chapter["cliKey"] == "1"
    assert len(dup_chapter["children"]) == 1
    dup_section = dup_chapter["children"][0]
    assert dup_section["title"] == "Section 1.1"
    assert dup_section["id"] != section["id"]
    assert dup_section["cliKey"] == "1-1"

    # Original project's outline is untouched.
    original_response = await client.get(f"/api/v1/projects/{project['id']}")
    assert len(original_response.json()["outline"]) == 1


async def _start_active_run(session_factory: async_sessionmaker[AsyncSession], project_id: str) -> None:
    now = datetime.now(timezone.utc)
    async with session_factory() as session:
        await SqlAlchemyRunRepository(session).add(
            Run(
                id=uuid.uuid4(),
                project_id=uuid.UUID(project_id),
                kind=RunKind.full,
                status=RunStatus.running,
                options=RunOptions(outline="generate", output_format="markdown"),
                base_run_id=None,
                target_node_id=None,
                target_node_previous_status=None,
                work_dir="/tmp/does-not-matter",
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
        )


async def test_structural_outline_writes_are_rejected_while_a_run_is_active(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """Regression for issue #74: a structural outline edit (insert, delete,
    full replace, or a move via PATCH's `parentId`/`orderIndex`) landing
    while a run is active shifts every sibling's recomputed `cli_key`, so
    `graph_import.py` - which matches the CLI's output back onto outline
    rows by recomputing that key from the *current* tree - silently writes
    one node's generated content and title onto a different, unrelated row
    once the run finishes. Non-structural edits (title/summary/content) are
    still safe and must stay allowed."""
    project = await _create_project(client)
    project_id = project["id"]
    chapter = await _create_node(client, project_id, title="Chapter 1")

    await _start_active_run(session_factory, project_id)

    create_response = await client.post(
        f"/api/v1/projects/{project_id}/outline", json={"title": "New", "parentId": None}
    )
    assert create_response.status_code == 409

    delete_response = await client.delete(
        f"/api/v1/projects/{project_id}/outline/{chapter['id']}"
    )
    assert delete_response.status_code == 409

    replace_response = await client.put(
        f"/api/v1/projects/{project_id}/outline", json=[{"title": "Only chapter"}]
    )
    assert replace_response.status_code == 409

    move_response = await client.patch(
        f"/api/v1/projects/{project_id}/outline/{chapter['id']}", json={"orderIndex": 5}
    )
    assert move_response.status_code == 409

    content_response = await client.patch(
        f"/api/v1/projects/{project_id}/outline/{chapter['id']}",
        json={"title": "Renamed while a run is active"},
    )
    assert content_response.status_code == 200
    assert content_response.json()["title"] == "Renamed while a run is active"


async def test_flat_and_tree_formats_are_equivalent(client: AsyncClient) -> None:
    project = await _create_project(client)
    project_id = project["id"]
    chapter1 = await _create_node(client, project_id, title="Chapter 1")
    await _create_node(client, project_id, title="Section 1.1", parentId=chapter1["id"])
    await _create_node(client, project_id, title="Section 1.2", parentId=chapter1["id"])
    await _create_node(client, project_id, title="Chapter 2")

    flat_response = await client.get(f"/api/v1/projects/{project_id}/outline")
    tree_response = await client.get(
        f"/api/v1/projects/{project_id}/outline", params={"format": "tree"}
    )

    flat_items = flat_response.json()["items"]
    tree_items = tree_response.json()["items"]

    def flatten_tree(nodes: list[dict]) -> list[dict]:
        result = []
        for node in nodes:
            children = node.get("children", [])
            result.append({k: v for k, v in node.items() if k != "children"})
            result.extend(flatten_tree(children))
        return result

    flattened_from_tree = flatten_tree(tree_items)
    assert {n["id"] for n in flattened_from_tree} == {n["id"] for n in flat_items}
    by_id_flat = {n["id"]: n for n in flat_items}
    for node in flattened_from_tree:
        assert node["cliKey"] == by_id_flat[node["id"]]["cliKey"]
        assert node["sectionNumber"] == by_id_flat[node["id"]]["sectionNumber"]


async def test_outline_repository_update_raises_not_found_when_row_vanishes(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """Regression for issue #62: `SqlAlchemyOutlineRepository.update` used
    to `assert record is not None` when the row disappeared between the
    caller's read and this write (e.g. a concurrent hard delete) - a bare
    `AssertionError` (an unhandled 500 that, under `python -O`, vanishes
    entirely and lets the next line raise a confusing `AttributeError`
    instead). Must raise a proper `NotFound` (404-mapped) error instead."""
    project = await _create_project(client)
    node = await _create_node(client, project["id"], title="Chapter 1")
    node_id = uuid.UUID(node["id"])

    async with session_factory() as session:
        baseline = await SqlAlchemyOutlineRepository(session).get(node_id)
    assert baseline is not None

    async with session_factory() as session:
        record = await session.get(OutlineNodeRecord, node_id)
        assert record is not None
        await session.delete(record)
        await session.commit()

    async with session_factory() as session:
        with pytest.raises(NotFound):
            await SqlAlchemyOutlineRepository(session).update(baseline, fields=("title",))
