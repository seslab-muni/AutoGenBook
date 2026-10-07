"""Issue #182: margin cards follow their text (`api.application.reanchor`).

The one re-anchoring function runs on a `contentMarkdown` PATCH and on every
graph-import content write, in the same transaction as the content write.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.application.graph_import import import_graph, import_single_node
from api.domain.models import CommentKind, CommentStatus, NodeComment
from api.infrastructure.db.comment_repository import SqlAlchemyCommentRepository
from api.infrastructure.db.models import NodeCommentRecord
from api.infrastructure.db.outline_repository import SqlAlchemyOutlineRepository
from api.infrastructure.db.repositories import SqlAlchemyProjectRepository
from api.infrastructure.db.source_repository import SqlAlchemySourceRepository
from tests.api.test_graph_import import _make_node, _make_project, _write_structure_graph

PROJECT = {"title": "Intro", "subtitle": "S", "authors": ["Ada"], "topic": "widgets"}
TEXT = "Intro line.\n\nThe quick brown fox jumps over the lazy dog near the river bank.\n\nOutro."
QUOTE = "quick brown fox jumps over the lazy dog"


async def _setup(client: AsyncClient, content: str) -> tuple[str, str]:
    project_id = (await client.post("/api/v1/projects", json=PROJECT)).json()["id"]
    node_id = (
        await client.post(f"/api/v1/projects/{project_id}/outline", json={"title": "Ch 1"})
    ).json()["id"]
    patched = await client.patch(
        f"/api/v1/projects/{project_id}/outline/{node_id}", json={"contentMarkdown": content}
    )
    assert patched.status_code == 200, patched.text
    return project_id, node_id


async def _comment(client: AsyncClient, project_id: str, node_id: str, quote: str, body="c") -> dict:
    response = await client.post(
        f"/api/v1/projects/{project_id}/outline/{node_id}/comments",
        json={"bodyMarkdown": body, "anchor": {"quote": quote}},
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _patch(client: AsyncClient, project_id: str, node_id: str, content: str) -> None:
    response = await client.patch(
        f"/api/v1/projects/{project_id}/outline/{node_id}", json={"contentMarkdown": content}
    )
    assert response.status_code == 200, response.text


async def _get(client: AsyncClient, comment_id: str) -> dict:
    # `GET /comments/{id}` arrives with the revision endpoints; the node list
    # carries the same rows.
    project = (await client.get("/api/v1/projects")).json()["items"][0]["id"]
    rows = (await client.get(f"/api/v1/projects/{project}/comments")).json()["items"]
    return next(r for r in rows if r["id"] == comment_id)


async def test_patch_shifts_the_anchor_with_the_text(authed_client: AsyncClient) -> None:
    project_id, node_id = await _setup(authed_client, TEXT)
    card = await _comment(authed_client, project_id, node_id, QUOTE)
    assert card["anchor"]["start"] == TEXT.index(QUOTE)

    shifted = "A new first paragraph that moves things.\n\n" + TEXT
    await _patch(authed_client, project_id, node_id, shifted)
    after = await _get(authed_client, card["id"])
    assert after["status"] == "open"
    assert after["anchor"]["start"] == shifted.index(QUOTE)
    assert shifted[after["anchor"]["start"] : after["anchor"]["end"]] == QUOTE
    assert after["anchor"]["prefix"] == shifted[after["anchor"]["start"] - 32 : after["anchor"]["start"]]


async def test_patch_orphans_then_unorphans_and_resolved_stays_resolved(
    authed_client: AsyncClient,
) -> None:
    project_id, node_id = await _setup(authed_client, TEXT)
    open_card = await _comment(authed_client, project_id, node_id, QUOTE, "open")
    done_card = await _comment(authed_client, project_id, node_id, QUOTE, "done")
    assert (await authed_client.post(f"/api/v1/comments/{done_card['id']}/resolve")).status_code == 200

    await _patch(authed_client, project_id, node_id, "Completely different text now.")
    gone = await _get(authed_client, open_card["id"])
    assert gone["status"] == "orphaned" and gone["anchor"]["start"] is None
    assert gone["anchor"]["quote"] == QUOTE  # the quote is kept for display
    assert (await _get(authed_client, done_card["id"]))["status"] == "resolved"

    await _patch(authed_client, project_id, node_id, "Prefix. " + TEXT)
    back = await _get(authed_client, open_card["id"])
    assert back["status"] == "open" and back["anchor"]["start"] == ("Prefix. " + TEXT).index(QUOTE)
    still = await _get(authed_client, done_card["id"])
    assert still["status"] == "resolved" and still["anchor"]["start"] is not None


async def test_patch_with_astral_characters_uses_code_point_offsets(
    authed_client: AsyncClient,
) -> None:
    text = "😀😀 intro.\n\nThe target sentence sits here, 😀 right here.\n"
    project_id, node_id = await _setup(authed_client, text)
    card = await _comment(authed_client, project_id, node_id, "target sentence sits here")
    shifted = "😀😀😀 more.\n" + text
    await _patch(authed_client, project_id, node_id, shifted)
    after = await _get(authed_client, card["id"])
    start = shifted.index("target sentence sits here")
    assert after["anchor"]["start"] == start
    assert after["anchor"]["end"] == start + len("target sentence sits here")


async def test_a_slightly_edited_quote_is_fuzzily_followed_and_the_quote_rewritten(
    authed_client: AsyncClient,
) -> None:
    project_id, node_id = await _setup(authed_client, TEXT)
    card = await _comment(authed_client, project_id, node_id, QUOTE)
    edited = TEXT.replace("jumps over", "leaps over")
    await _patch(authed_client, project_id, node_id, edited)
    after = await _get(authed_client, card["id"])
    assert after["status"] == "open"
    assert edited[after["anchor"]["start"] : after["anchor"]["end"]] == after["anchor"]["quote"]
    assert "leaps over" in after["anchor"]["quote"]


async def test_patch_other_fields_leave_the_cards_alone(authed_client: AsyncClient) -> None:
    project_id, node_id = await _setup(authed_client, TEXT)
    card = await _comment(authed_client, project_id, node_id, QUOTE)
    response = await authed_client.patch(
        f"/api/v1/projects/{project_id}/outline/{node_id}", json={"title": "Renamed"}
    )
    assert response.status_code == 200
    assert (await _get(authed_client, card["id"]))["anchor"] == card["anchor"]


async def test_reanchoring_does_not_query_per_card(
    authed_client: AsyncClient, count_statements
) -> None:
    project_id, node_id = await _setup(authed_client, TEXT)
    await _comment(authed_client, project_id, node_id, QUOTE)
    with count_statements() as few:
        await _patch(authed_client, project_id, node_id, "X " + TEXT)
    for i in range(6):
        await _comment(authed_client, project_id, node_id, "Intro line.", f"c{i}")
    with count_statements() as many:
        await _patch(authed_client, project_id, node_id, "Y " + TEXT)
    # Seven cards cost about the same number of statements as one.
    assert len(many) <= len(few) + 2, (len(few), len(many))


async def test_pending_suggestion_anchor_follows_and_status_is_kept(
    authed_client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    project_id, node_id = await _setup(authed_client, TEXT)
    start = TEXT.index(QUOTE)
    now = datetime.now(timezone.utc)
    suggestion_id = uuid.uuid4()
    async with session_factory() as session:
        node = await SqlAlchemyOutlineRepository(session).get(uuid.UUID(node_id))
        assert node is not None
        await SqlAlchemyCommentRepository(session).add(
            NodeComment(
                id=suggestion_id, project_id=uuid.UUID(project_id), node_id=node.id,
                kind=CommentKind.SUGGESTION, author_id=None,
                anchor={"quote": QUOTE, "prefix": "", "suffix": "", "start": start, "end": start + len(QUOTE)},
                status=CommentStatus.PENDING, thread_id=suggestion_id, parent_id=None,
                body_markdown="", payload={}, created_at=now, updated_at=now,
            )
        )
    await _patch(authed_client, project_id, node_id, "Gone. Totally different.")
    async with session_factory() as session:
        row = (await session.execute(select(NodeCommentRecord).where(NodeCommentRecord.id == suggestion_id))).scalar_one()
    assert row.status == "pending"  # never silently dropped
    assert row.anchor["start"] is None


# ------------------------------------------------------------ graph import
async def _import_setup(session: AsyncSession, tmp_path: Path, old: str, new: str, *, single: bool):
    project = await SqlAlchemyProjectRepository(session).add(_make_project())
    outline = SqlAlchemyOutlineRepository(session)
    node = await outline.add(_make_node(project.id, None, 0, content_markdown=old, cli_key="1"))
    comments = SqlAlchemyCommentRepository(session)
    start = old.index(QUOTE)
    card_id = uuid.uuid4()
    now = datetime.now(timezone.utc)
    await comments.add(
        NodeComment(
            id=card_id, project_id=project.id, node_id=node.id, kind=CommentKind.COMMENT,
            author_id=None, anchor={"quote": QUOTE, "prefix": "", "suffix": "", "start": start, "end": start + len(QUOTE)},
            status=CommentStatus.OPEN, thread_id=card_id, parent_id=None, body_markdown="x",
            payload={}, created_at=now, updated_at=now,
        )
    )
    work_dir = tmp_path / "run"
    out_dir = work_dir / "out"
    (out_dir / "sections").mkdir(parents=True)
    (out_dir / "sections" / "1.md").write_text(new, encoding="utf-8")
    _write_structure_graph(out_dir, nodes={"book": {}, "1": {"title": "Node 0"}}, edges=[["book", "1"]])
    if single:
        await import_single_node(project, work_dir, node.id, outline, comment_repository=comments)
    else:
        await import_graph(
            project, work_dir, outline, SqlAlchemySourceRepository(session), comment_repository=comments
        )
    return card_id


async def test_graph_import_reanchors_cards_of_rewritten_text(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    new = "Brand new opening paragraph.\n\n" + TEXT
    async with session_factory() as session:
        card_id = await _import_setup(session, tmp_path, TEXT, new, single=False)
        row = (await session.execute(select(NodeCommentRecord).where(NodeCommentRecord.id == card_id))).scalar_one()
    assert row.status == "open" and row.anchor["start"] == new.index(QUOTE)


async def test_graph_import_orphans_cards_whose_text_is_gone_single_node(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    async with session_factory() as session:
        card_id = await _import_setup(session, tmp_path, TEXT, "Rewritten from scratch.\n", single=True)
        row = (await session.execute(select(NodeCommentRecord).where(NodeCommentRecord.id == card_id))).scalar_one()
    assert row.status == "orphaned" and row.anchor["start"] is None
