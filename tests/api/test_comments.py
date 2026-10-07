from __future__ import annotations

import uuid
from datetime import datetime, timezone

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.infrastructure.db.models import NodeCommentRecord

PROJECT = {"title": "Intro", "subtitle": "S", "authors": ["Ada"], "topic": "widgets"}


async def _setup(client: AsyncClient, content: str = "") -> tuple[str, str]:
    response = await client.post("/api/v1/projects", json=PROJECT)
    assert response.status_code == 201, response.text
    project_id = response.json()["id"]
    node = await client.post(f"/api/v1/projects/{project_id}/outline", json={"title": "Ch 1"})
    assert node.status_code == 201, node.text
    node_id = node.json()["id"]
    if content:
        patched = await client.patch(
            f"/api/v1/projects/{project_id}/outline/{node_id}", json={"contentMarkdown": content}
        )
        assert patched.status_code == 200, patched.text
    return project_id, node_id


def _url(project_id: str, node_id: str) -> str:
    return f"/api/v1/projects/{project_id}/outline/{node_id}/comments"


async def _post(client: AsyncClient, project_id: str, node_id: str, **body) -> dict:
    response = await client.post(_url(project_id, node_id), json=body)
    assert response.status_code == 201, response.text
    return response.json()


async def test_create_and_list_whole_section_comment(authed_client: AsyncClient) -> None:
    project_id, node_id = await _setup(authed_client)
    created = await _post(authed_client, project_id, node_id, bodyMarkdown="Looks good")
    assert created["kind"] == "comment"
    assert created["status"] == "open"
    assert created["anchor"] is None
    assert created["threadId"] == created["id"]
    assert created["parentId"] is None
    assert created["authorName"]
    assert created["payload"] == {}

    listed = (await authed_client.get(_url(project_id, node_id))).json()
    assert [item["id"] for item in listed["items"]] == [created["id"]]
    assert listed["total"] == 1


async def test_threading_replies_inherit_root_anchor(authed_client: AsyncClient) -> None:
    content = "Alpha beta gamma."
    project_id, node_id = await _setup(authed_client, content)
    root = await _post(
        authed_client,
        project_id,
        node_id,
        bodyMarkdown="root",
        anchor={"quote": "beta", "start": 6, "end": 10},
    )
    reply = await _post(authed_client, project_id, node_id, bodyMarkdown="r1", parentId=root["id"])
    nested = await _post(
        authed_client,
        project_id,
        node_id,
        bodyMarkdown="r2",
        parentId=reply["id"],
        anchor={"quote": "gamma"},  # ignored on a reply
    )
    assert reply["threadId"] == root["id"] and reply["anchor"] == root["anchor"]
    assert nested["threadId"] == root["id"] and nested["parentId"] == root["id"]  # flat
    assert nested["anchor"] == root["anchor"]

    ids = [c["id"] for c in (await authed_client.get(_url(project_id, node_id))).json()["items"]]
    assert ids == [root["id"], reply["id"], nested["id"]]


async def test_reply_to_unknown_or_foreign_node_parent_is_404(authed_client: AsyncClient) -> None:
    project_id, node_id = await _setup(authed_client)
    other = await authed_client.post(f"/api/v1/projects/{project_id}/outline", json={"title": "Ch 2"})
    root = await _post(authed_client, project_id, node_id, bodyMarkdown="root")
    response = await authed_client.post(
        _url(project_id, other.json()["id"]), json={"bodyMarkdown": "x", "parentId": root["id"]}
    )
    assert response.status_code == 404
    response = await authed_client.post(
        _url(project_id, node_id), json={"bodyMarkdown": "x", "parentId": str(uuid.uuid4())}
    )
    assert response.status_code == 404


async def test_anchor_offsets_count_code_points_not_utf16(authed_client: AsyncClient) -> None:
    content = "😀😀 see the target here"  # two astral chars before the range
    quote = "target"
    start = content.index(quote)
    assert start == 11 and len(content.encode("utf-16-le")) // 2 != len(content)
    project_id, node_id = await _setup(authed_client, content)
    created = await _post(
        authed_client,
        project_id,
        node_id,
        bodyMarkdown="c",
        anchor={"quote": quote, "start": start, "end": start + len(quote)},
    )
    assert created["status"] == "open"
    assert created["anchor"] == {
        "quote": "target",
        "prefix": "😀😀 see the ",
        "suffix": " here",
        "start": 11,
        "end": 17,
    }


async def test_client_offsets_that_do_not_match_fall_back_to_unique_find(
    authed_client: AsyncClient,
) -> None:
    project_id, node_id = await _setup(authed_client, "one two three")
    created = await _post(
        authed_client,
        project_id,
        node_id,
        bodyMarkdown="c",
        anchor={"quote": "two", "start": 0, "end": 3},  # wrong (UTF-16-style) offsets
    )
    assert (created["anchor"]["start"], created["anchor"]["end"]) == (4, 7)
    assert created["status"] == "open"


async def test_unmatched_or_ambiguous_quote_is_orphaned(authed_client: AsyncClient) -> None:
    project_id, node_id = await _setup(authed_client, "echo echo")
    missing = await _post(
        authed_client,
        project_id,
        node_id,
        bodyMarkdown="c",
        anchor={"quote": "absent", "prefix": "p", "suffix": "s"},
    )
    assert missing["status"] == "orphaned"
    assert missing["anchor"] == {
        "quote": "absent",
        "prefix": "p",
        "suffix": "s",
        "start": None,
        "end": None,
    }
    ambiguous = await _post(
        authed_client, project_id, node_id, bodyMarkdown="c", anchor={"quote": "echo"}
    )
    assert ambiguous["status"] == "orphaned"
    assert ambiguous["anchor"]["start"] is None


async def test_anchor_shape_validation(authed_client: AsyncClient) -> None:
    project_id, node_id = await _setup(authed_client, "abc def")
    url = _url(project_id, node_id)
    bad_anchors = [
        {"quote": ""},
        {"quote": "abc", "start": 0},
        {"quote": "abc", "end": 3},
        {"quote": "abc", "start": 3, "end": 0},
        {"quote": "abc", "start": 0, "end": 5},  # length mismatch
        {"quote": "abc", "start": -1, "end": 2},
        {"quote": "abc", "prefix": "x" * 33},
        {"quote": "abc", "extra": 1},
    ]
    for anchor in bad_anchors:
        response = await authed_client.post(url, json={"bodyMarkdown": "c", "anchor": anchor})
        assert response.status_code == 422, anchor
    blank = await authed_client.post(url, json={"bodyMarkdown": "  "})
    assert blank.status_code == 422


async def test_unknown_project_or_node_404(authed_client: AsyncClient) -> None:
    project_id, node_id = await _setup(authed_client)
    assert (await authed_client.get(_url(str(uuid.uuid4()), node_id))).status_code == 404
    assert (await authed_client.get(_url(project_id, str(uuid.uuid4())))).status_code == 404
    assert (
        await authed_client.get(f"/api/v1/projects/{uuid.uuid4()}/comments")
    ).status_code == 404


async def test_requires_login(client: AsyncClient) -> None:
    url = f"/api/v1/projects/{uuid.uuid4()}/outline/{uuid.uuid4()}/comments"
    assert (await client.get(url)).status_code == 401
    assert (await client.get(f"/api/v1/projects/{uuid.uuid4()}/comments")).status_code == 401
    assert (
        await client.patch(f"/api/v1/comments/{uuid.uuid4()}", json={"bodyMarkdown": "x"})
    ).status_code == 401


async def test_second_user_can_comment_but_not_edit_or_delete_others(
    authed_client: AsyncClient, authed_client_2: AsyncClient
) -> None:
    project_id, node_id = await _setup(authed_client)
    mine = await _post(authed_client, project_id, node_id, bodyMarkdown="mine")
    theirs = await _post(authed_client_2, project_id, node_id, bodyMarkdown="theirs")
    assert mine["authorId"] != theirs["authorId"]

    assert (
        await authed_client_2.patch(f"/api/v1/comments/{mine['id']}", json={"bodyMarkdown": "x"})
    ).status_code == 403
    assert (await authed_client_2.delete(f"/api/v1/comments/{mine['id']}")).status_code == 403
    # Anyone may resolve a thread.
    assert (await authed_client_2.post(f"/api/v1/comments/{mine['id']}/resolve")).status_code == 200

    edited = await authed_client.patch(
        f"/api/v1/comments/{mine['id']}", json={"bodyMarkdown": "edited"}
    )
    assert edited.status_code == 200 and edited.json()["bodyMarkdown"] == "edited"
    listed = (await authed_client_2.get(f"/api/v1/projects/{project_id}/comments")).json()
    assert {c["id"] for c in listed["items"]} == {mine["id"], theirs["id"]}


async def test_soft_delete_root_removes_thread_and_keeps_rows(
    authed_client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    project_id, node_id = await _setup(authed_client)
    root = await _post(authed_client, project_id, node_id, bodyMarkdown="root")
    reply = await _post(authed_client, project_id, node_id, bodyMarkdown="r", parentId=root["id"])
    keep = await _post(authed_client, project_id, node_id, bodyMarkdown="other")

    assert (await authed_client.delete(f"/api/v1/comments/{reply['id']}")).status_code == 204
    ids = [c["id"] for c in (await authed_client.get(_url(project_id, node_id))).json()["items"]]
    assert ids == [root["id"], keep["id"]]

    assert (await authed_client.delete(f"/api/v1/comments/{root['id']}")).status_code == 204
    ids = [c["id"] for c in (await authed_client.get(_url(project_id, node_id))).json()["items"]]
    assert ids == [keep["id"]]
    assert (await authed_client.delete(f"/api/v1/comments/{root['id']}")).status_code == 404
    assert (
        await authed_client.patch(f"/api/v1/comments/{root['id']}", json={"bodyMarkdown": "x"})
    ).status_code == 404

    async with session_factory() as session:
        record = await session.get(NodeCommentRecord, uuid.UUID(root["id"]))
        assert record is not None and record.deleted_at is not None


async def test_resolve_and_reopen(authed_client: AsyncClient) -> None:
    project_id, node_id = await _setup(authed_client, "alpha beta")
    root = await _post(authed_client, project_id, node_id, bodyMarkdown="root")
    reply = await _post(authed_client, project_id, node_id, bodyMarkdown="r", parentId=root["id"])

    resolved = await authed_client.post(f"/api/v1/comments/{root['id']}/resolve")
    assert resolved.status_code == 200 and resolved.json()["status"] == "resolved"
    reopened = await authed_client.post(
        f"/api/v1/comments/{root['id']}/resolve", json={"resolved": False}
    )
    assert reopened.json()["status"] == "open"
    assert (await authed_client.post(f"/api/v1/comments/{reply['id']}/resolve")).status_code == 409

    orphan = await _post(
        authed_client, project_id, node_id, bodyMarkdown="o", anchor={"quote": "nowhere"}
    )
    await authed_client.post(f"/api/v1/comments/{orphan['id']}/resolve", json={"resolved": True})
    again = await authed_client.post(
        f"/api/v1/comments/{orphan['id']}/resolve", json={"resolved": False}
    )
    assert again.json()["status"] == "orphaned"

    status_filtered = await authed_client.get(_url(project_id, node_id) + "?status=orphaned")
    assert [c["id"] for c in status_filtered.json()["items"]] == [orphan["id"]]
    kind_filtered = await authed_client.get(_url(project_id, node_id) + "?kind=review")
    assert kind_filtered.json()["items"] == []


async def _insert_row(
    session_factory: async_sessionmaker[AsyncSession],
    project_id: str,
    node_id: str,
    **overrides,
) -> None:
    now = datetime.now(timezone.utc)
    row_id = uuid.uuid4()
    values = dict(
        id=row_id,
        project_id=uuid.UUID(project_id),
        node_id=uuid.UUID(node_id),
        kind="suggestion",
        author_id=None,
        anchor=None,
        status="pending",
        thread_id=row_id,
        parent_id=None,
        body_markdown="",
        payload={},
        created_at=now,
        updated_at=now,
    )
    values.update(overrides)
    async with session_factory() as session:
        session.add(NodeCommentRecord(**values))
        await session.commit()


async def test_outline_nodes_carry_badge_counts(
    authed_client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    project_id, node_id = await _setup(authed_client)
    quiet = (
        await authed_client.post(f"/api/v1/projects/{project_id}/outline", json={"title": "Ch 2"})
    ).json()
    assert quiet["openCommentCount"] == 0 and quiet["pendingSuggestionCount"] == 0

    first = await _post(authed_client, project_id, node_id, bodyMarkdown="a")
    await _post(authed_client, project_id, node_id, bodyMarkdown="reply", parentId=first["id"])
    second = await _post(authed_client, project_id, node_id, bodyMarkdown="b")
    third = await _post(authed_client, project_id, node_id, bodyMarkdown="c")
    await authed_client.post(f"/api/v1/comments/{second['id']}/resolve")
    await authed_client.delete(f"/api/v1/comments/{third['id']}")
    orphan = await _post(
        authed_client, project_id, node_id, bodyMarkdown="o", anchor={"quote": "nope"}
    )
    assert orphan["status"] == "orphaned"
    await _insert_row(session_factory, project_id, node_id, status="pending")
    await _insert_row(session_factory, project_id, node_id, status="running")
    for done in ("accepted", "rejected", "failed", "cancelled"):
        await _insert_row(session_factory, project_id, node_id, status=done)
    await _insert_row(session_factory, project_id, node_id, kind="review", status="open")

    def counts(items: list[dict]) -> dict[str, tuple[int, int]]:
        return {n["id"]: (n["openCommentCount"], n["pendingSuggestionCount"]) for n in items}

    flat = (await authed_client.get(f"/api/v1/projects/{project_id}/outline")).json()["items"]
    assert counts(flat)[node_id] == (2, 2)
    assert counts(flat)[quiet["id"]] == (0, 0)

    tree = (
        await authed_client.get(f"/api/v1/projects/{project_id}/outline?format=tree")
    ).json()["items"]
    assert counts(tree)[node_id] == (2, 2)

    single = (await authed_client.get(f"/api/v1/projects/{project_id}/outline/{node_id}")).json()
    assert (single["openCommentCount"], single["pendingSuggestionCount"]) == (2, 2)
    patched = await authed_client.patch(
        f"/api/v1/projects/{project_id}/outline/{node_id}", json={"title": "Renamed"}
    )
    assert patched.json()["openCommentCount"] == 2


async def test_counts_use_a_single_extra_query(
    authed_client: AsyncClient, count_statements
) -> None:
    project_id, node_id = await _setup(authed_client)
    for _ in range(3):
        await authed_client.post(f"/api/v1/projects/{project_id}/outline", json={"title": "n"})
        await _post(authed_client, project_id, node_id, bodyMarkdown="a")
    with count_statements() as statements:
        response = await authed_client.get(f"/api/v1/projects/{project_id}/outline")
    assert response.status_code == 200
    assert sum("node_comments" in s for s in statements) == 1


async def test_deleted_node_comments_are_not_listed(authed_client: AsyncClient) -> None:
    project_id, node_id = await _setup(authed_client)
    await _post(authed_client, project_id, node_id, bodyMarkdown="a")
    assert (await authed_client.get(f"/api/v1/projects/{project_id}/comments")).json()["total"] == 1
    assert (
        await authed_client.delete(f"/api/v1/projects/{project_id}/outline/{node_id}")
    ).status_code == 204
    assert (await authed_client.get(f"/api/v1/projects/{project_id}/comments")).json()["total"] == 0
    assert (await authed_client.get(_url(project_id, node_id))).status_code == 404


async def test_stored_anchor_with_odd_shape_still_serialises(
    authed_client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    project_id, node_id = await _setup(authed_client, "abc")
    odd = {"quote": "abc", "prefix": "p" * 50, "suffix": "", "start": 0, "end": 99, "extra": 1}
    await _insert_row(
        session_factory, project_id, node_id, kind="review", status="open", anchor=odd
    )
    response = await authed_client.get(_url(project_id, node_id))
    assert response.status_code == 200, response.text
    anchor = response.json()["items"][0]["anchor"]
    assert anchor["end"] == 99 and len(anchor["prefix"]) == 50 and "extra" not in anchor

    for bad in (
        {},
        {"prefix": "p"},
        {"quote": 5, "start": "0", "end": 3},
        {"quote": "abc", "start": 1},
        {"quote": "abc", "start": 5, "end": 2},
        {"quote": "abc", "start": True, "end": 2.5},
        {"quote": None, "prefix": None, "suffix": 7, "start": -1, "end": -1},
    ):
        await _insert_row(
            session_factory, project_id, node_id, kind="review", status="open", anchor=bad
        )
    response = await authed_client.get(_url(project_id, node_id))
    assert response.status_code == 200, response.text
    for item in response.json()["items"][1:]:
        assert item["anchor"]["start"] is None and item["anchor"]["end"] is None
        assert isinstance(item["anchor"]["quote"], str)


async def test_nul_and_oversized_input_rejected(authed_client: AsyncClient) -> None:
    project_id, node_id = await _setup(authed_client, "abc")
    url = _url(project_id, node_id)
    for body in (
        {"bodyMarkdown": "a\x00b"},
        {"bodyMarkdown": "x" * 20_001},
        {"bodyMarkdown": "c", "anchor": {"quote": "a\x00"}},
        {"bodyMarkdown": "c", "anchor": {"quote": "a", "prefix": "\x00"}},
        {"bodyMarkdown": "c", "anchor": {"quote": "a", "suffix": "\x00"}},
        {"bodyMarkdown": "c", "anchor": {"quote": "q" * 20_001}},
    ):
        assert (await authed_client.post(url, json=body)).status_code == 422
    ok = await _post(authed_client, project_id, node_id, bodyMarkdown="x" * 20_000)
    assert (
        await authed_client.patch(f"/api/v1/comments/{ok['id']}", json={"bodyMarkdown": "a\x00"})
    ).status_code == 422
    assert (
        await authed_client.patch(
            f"/api/v1/comments/{ok['id']}", json={"bodyMarkdown": "x" * 20_001}
        )
    ).status_code == 422


async def test_soft_deleted_project_hides_comments(authed_client: AsyncClient) -> None:
    project_id, node_id = await _setup(authed_client)
    mine = await _post(authed_client, project_id, node_id, bodyMarkdown="a")
    assert (await authed_client.delete(f"/api/v1/projects/{project_id}")).status_code == 204
    assert (
        await authed_client.patch(f"/api/v1/comments/{mine['id']}", json={"bodyMarkdown": "x"})
    ).status_code == 404
    assert (await authed_client.delete(f"/api/v1/comments/{mine['id']}")).status_code == 404
    assert (await authed_client.post(f"/api/v1/comments/{mine['id']}/resolve")).status_code == 404


async def test_project_node_mismatch_is_404(authed_client: AsyncClient) -> None:
    project_a, node_a = await _setup(authed_client)
    project_b, node_b = await _setup(authed_client)
    assert (await authed_client.get(_url(project_a, node_b))).status_code == 404
    response = await authed_client.post(_url(project_a, node_b), json={"bodyMarkdown": "x"})
    assert response.status_code == 404


async def test_reply_state_mirrors_root_and_reopens(authed_client: AsyncClient) -> None:
    project_id, node_id = await _setup(authed_client, "alpha beta")
    root = await _post(
        authed_client, project_id, node_id, bodyMarkdown="r", anchor={"quote": "beta"}
    )
    reply = await _post(authed_client, project_id, node_id, bodyMarkdown="1", parentId=root["id"])
    assert reply["anchor"] == root["anchor"] and reply["status"] == "open"

    await authed_client.post(f"/api/v1/comments/{root['id']}/resolve")
    items = (await authed_client.get(_url(project_id, node_id))).json()["items"]
    assert [i["status"] for i in items] == ["resolved", "resolved"]  # reply mirrors root
    # Replying reopens the resolved thread.
    second = await _post(authed_client, project_id, node_id, bodyMarkdown="2", parentId=root["id"])
    assert second["status"] == "open"
    items = (await authed_client.get(_url(project_id, node_id))).json()["items"]
    assert [i["status"] for i in items] == ["open"] * 3

    orphan = await _post(
        authed_client, project_id, node_id, bodyMarkdown="o", anchor={"quote": "zzz"}
    )
    await authed_client.post(f"/api/v1/comments/{orphan['id']}/resolve")
    back = await _post(authed_client, project_id, node_id, bodyMarkdown="b", parentId=orphan["id"])
    assert back["status"] == "orphaned"


async def test_filters_select_roots_and_return_whole_threads(
    authed_client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    project_id, node_id = await _setup(authed_client)
    open_root = await _post(authed_client, project_id, node_id, bodyMarkdown="open")
    done_root = await _post(authed_client, project_id, node_id, bodyMarkdown="done")
    await _post(authed_client, project_id, node_id, bodyMarkdown="rep", parentId=open_root["id"])
    await _post(authed_client, project_id, node_id, bodyMarkdown="rep", parentId=done_root["id"])
    await authed_client.post(f"/api/v1/comments/{done_root['id']}/resolve")
    await authed_client.post(f"/api/v1/comments/{done_root['id']}/resolve")

    for base in (_url(project_id, node_id), f"/api/v1/projects/{project_id}/comments"):
        resolved = (await authed_client.get(base + "?status=resolved")).json()
        assert {i["threadId"] for i in resolved["items"]} == {done_root["id"]}
        assert len(resolved["items"]) == 2
    paged = (await authed_client.get(f"/api/v1/projects/{project_id}/comments?limit=1")).json()
    assert paged["total"] == 2 and paged["limit"] == 1
    assert {i["threadId"] for i in paged["items"]} == {open_root["id"]}
    assert len(paged["items"]) == 2
    second = (
        await authed_client.get(f"/api/v1/projects/{project_id}/comments?limit=1&offset=1")
    ).json()
    assert {i["threadId"] for i in second["items"]} == {done_root["id"]}


async def test_reply_under_suggestion_is_409(
    authed_client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    project_id, node_id = await _setup(authed_client)
    suggestion_id = uuid.uuid4()
    await _insert_row(
        session_factory, project_id, node_id, id=suggestion_id, thread_id=suggestion_id
    )
    response = await authed_client.post(
        _url(project_id, node_id), json={"bodyMarkdown": "x", "parentId": str(suggestion_id)}
    )
    assert response.status_code == 409
    assert (await authed_client.post(f"/api/v1/comments/{suggestion_id}/resolve")).status_code == 409


async def test_authorless_rows(
    authed_client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    project_id, node_id = await _setup(authed_client)
    review_id, suggestion_id = uuid.uuid4(), uuid.uuid4()
    await _insert_row(
        session_factory, project_id, node_id, id=review_id, thread_id=review_id,
        kind="review", status="open",
    )
    await _insert_row(session_factory, project_id, node_id, id=suggestion_id, thread_id=suggestion_id)
    for row_id in (review_id, suggestion_id):
        response = await authed_client.patch(
            f"/api/v1/comments/{row_id}", json={"bodyMarkdown": "x"}
        )
        assert response.status_code == 403
    # Any user may dismiss an authorless row.
    assert (await authed_client.delete(f"/api/v1/comments/{review_id}")).status_code == 204
    assert (await authed_client.delete(f"/api/v1/comments/{suggestion_id}")).status_code == 204


async def test_root_delete_takes_other_users_reply(
    authed_client: AsyncClient, authed_client_2: AsyncClient
) -> None:
    project_id, node_id = await _setup(authed_client)
    root = await _post(authed_client, project_id, node_id, bodyMarkdown="root")
    reply = await _post(authed_client_2, project_id, node_id, bodyMarkdown="r", parentId=root["id"])
    assert (await authed_client.delete(f"/api/v1/comments/{root['id']}")).status_code == 204
    assert (await authed_client_2.get(_url(project_id, node_id))).json()["items"] == []
    assert (
        await authed_client_2.patch(f"/api/v1/comments/{reply['id']}", json={"bodyMarkdown": "x"})
    ).status_code == 404


async def test_edited_at_only_set_by_body_edit(authed_client: AsyncClient) -> None:
    project_id, node_id = await _setup(authed_client)
    root = await _post(authed_client, project_id, node_id, bodyMarkdown="root")
    assert root["editedAt"] is None
    resolved = (await authed_client.post(f"/api/v1/comments/{root['id']}/resolve")).json()
    assert resolved["editedAt"] is None
    edited = (
        await authed_client.patch(f"/api/v1/comments/{root['id']}", json={"bodyMarkdown": "n"})
    ).json()
    assert edited["editedAt"] is not None


async def test_unauthenticated_mutations_401(client: AsyncClient) -> None:
    some = uuid.uuid4()
    base = f"/api/v1/projects/{some}/outline/{some}/comments"
    assert (await client.post(base, json={"bodyMarkdown": "x"})).status_code == 401
    assert (await client.delete(f"/api/v1/comments/{some}")).status_code == 401
    assert (await client.post(f"/api/v1/comments/{some}/resolve")).status_code == 401


async def test_tree_route_counts_use_a_single_query(
    authed_client: AsyncClient, count_statements
) -> None:
    project_id, node_id = await _setup(authed_client)
    await _post(authed_client, project_id, node_id, bodyMarkdown="a")
    with count_statements() as statements:
        response = await authed_client.get(f"/api/v1/projects/{project_id}/outline?format=tree")
    assert response.status_code == 200
    assert sum("node_comments" in s for s in statements) == 1


def test_resolve_anchor_uses_context_among_multiple_matches() -> None:
    from api.application.comment_anchors import resolve_anchor

    content = "foo bar. foo baz. foo qux."
    anchor = {"quote": "foo", "prefix": "bar. ", "suffix": " baz", "start": None, "end": None}
    resolved = resolve_anchor(content, anchor)
    assert (resolved["start"], resolved["end"]) == (9, 12)
    still_ambiguous = resolve_anchor(content, {"quote": "foo", "prefix": "", "suffix": ""})
    assert still_ambiguous["start"] is None


async def test_reply_vs_thread_delete_race_is_safe(
    authed_client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    seeded_user,
) -> None:
    from api.application.comments import CommentService
    from api.core.errors import NotFound
    from api.infrastructure.db.comment_repository import SqlAlchemyCommentRepository
    from api.infrastructure.db.outline_repository import SqlAlchemyOutlineRepository
    from api.infrastructure.db.repositories import SqlAlchemyProjectRepository

    project_id, node_id = await _setup(authed_client)
    root = await _post(authed_client, project_id, node_id, bodyMarkdown="root")

    async with session_factory() as svc_session, session_factory() as other_session:
        repo = SqlAlchemyCommentRepository(svc_session)
        real_get = repo.get
        fired = False

        async def get_then_delete(comment_id):  # noqa: ANN001
            nonlocal fired
            result = await real_get(comment_id)
            if not fired:
                fired = True  # the thread is deleted right after the service read the parent
                await SqlAlchemyCommentRepository(other_session).soft_delete_thread(
                    uuid.UUID(root["id"])
                )
            return result

        repo.get = get_then_delete  # type: ignore[method-assign]
        service = CommentService(
            repo,
            SqlAlchemyOutlineRepository(svc_session),
            SqlAlchemyProjectRepository(svc_session),
        )
        try:
            await service.create(
                uuid.UUID(project_id),
                uuid.UUID(node_id),
                seeded_user,
                body_markdown="late reply",
                parent_id=uuid.UUID(root["id"]),
            )
            raised = False
        except NotFound:
            raised = True
        assert raised
    assert (await authed_client.get(_url(project_id, node_id))).json()["items"] == []
    async with session_factory() as session:
        from sqlalchemy import select

        live = (
            await session.execute(
                select(NodeCommentRecord).where(
                    NodeCommentRecord.thread_id == uuid.UUID(root["id"]),
                    NodeCommentRecord.deleted_at.is_(None),
                )
            )
        ).all()
        assert live == []


async def test_patch_reply_returns_root_anchor_and_status(authed_client: AsyncClient) -> None:
    project_id, node_id = await _setup(authed_client, "alpha beta")
    root = await _post(
        authed_client, project_id, node_id, bodyMarkdown="r", anchor={"quote": "beta"}
    )
    reply = await _post(authed_client, project_id, node_id, bodyMarkdown="1", parentId=root["id"])
    await authed_client.post(f"/api/v1/comments/{root['id']}/resolve")
    edited = await authed_client.patch(
        f"/api/v1/comments/{reply['id']}", json={"bodyMarkdown": "edited"}
    )
    assert edited.json()["anchor"] == root["anchor"]
    assert edited.json()["status"] == "resolved"


async def test_reply_under_review_root(
    authed_client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    project_id, node_id = await _setup(authed_client)
    review_id = uuid.uuid4()
    await _insert_row(
        session_factory, project_id, node_id, id=review_id, thread_id=review_id,
        kind="review", status="open",
    )
    reply = await _post(
        authed_client, project_id, node_id, bodyMarkdown="fixing", parentId=str(review_id)
    )
    assert reply["threadId"] == str(review_id) and reply["kind"] == "comment"
    items = (await authed_client.get(_url(project_id, node_id) + "?kind=review")).json()["items"]
    assert [i["id"] for i in items] == [str(review_id), reply["id"]]


async def test_project_paging_is_disjoint_and_ordered(authed_client: AsyncClient) -> None:
    project_id, node_id = await _setup(authed_client)
    roots = []
    for index in range(5):
        root = await _post(authed_client, project_id, node_id, bodyMarkdown=f"r{index}")
        roots.append(root["id"])
    # Replies added out of order must stay inside their own thread.
    for root_id in reversed(roots[:3]):
        await _post(authed_client, project_id, node_id, bodyMarkdown="rep", parentId=root_id)
    base = f"/api/v1/projects/{project_id}/comments"
    full = [i["id"] for i in (await authed_client.get(base)).json()["items"]]
    paged: list[str] = []
    for offset in (0, 2, 4):
        page = (await authed_client.get(f"{base}?limit=2&offset={offset}")).json()
        assert page["total"] == 5
        paged += [i["id"] for i in page["items"]]
    assert paged == full and len(set(paged)) == len(full) == 8
    threads = [i["threadId"] for i in (await authed_client.get(base)).json()["items"]]
    assert threads == sorted(threads, key=roots.index)  # contiguous, in root order
    node_total = (await authed_client.get(_url(project_id, node_id))).json()["total"]
    assert node_total == 5


async def test_kind_filter_matches_suggestion_inside_comment_thread(
    authed_client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    project_id, node_id = await _setup(authed_client)
    plain = await _post(authed_client, project_id, node_id, bodyMarkdown="plain")
    prompted = await _post(authed_client, project_id, node_id, bodyMarkdown="prompt")
    child_id = uuid.uuid4()
    await _insert_row(
        session_factory, project_id, node_id, id=child_id,
        thread_id=uuid.UUID(prompted["id"]), parent_id=uuid.UUID(prompted["id"]),
        kind="suggestion", status="pending",
    )
    for base in (_url(project_id, node_id), f"/api/v1/projects/{project_id}/comments"):
        items = (await authed_client.get(base + "?kind=suggestion")).json()["items"]
        assert {i["threadId"] for i in items} == {prompted["id"]}
        assert child_id.hex in {i["id"].replace("-", "") for i in items}
        done = (await authed_client.get(base + "?kind=suggestion&status=accepted")).json()
        assert done["items"] == []
        both = (await authed_client.get(base + "?kind=suggestion&status=pending")).json()
        assert len(both["items"]) == 2
    assert plain["id"] not in {
        i["id"] for i in (await authed_client.get(_url(project_id, node_id) + "?kind=suggestion")).json()["items"]
    }
