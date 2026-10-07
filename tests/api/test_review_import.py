"""Issue #182 phase 3: reviewer issues become `kind=review` cards.

`graph_import` writes one row per issue of `section_reviews/<key>.json`
(`api.application.review_import`); re-importing never duplicates them.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.application.graph_import import import_graph, import_single_node
from api.application.review_import import issue_key
from api.infrastructure.db.comment_repository import SqlAlchemyCommentRepository
from api.infrastructure.db.models import NodeCommentRecord
from api.infrastructure.db.outline_repository import SqlAlchemyOutlineRepository
from api.infrastructure.db.repositories import SqlAlchemyProjectRepository
from api.infrastructure.db.source_repository import SqlAlchemySourceRepository
from tests.api.test_graph_import import _make_node, _make_project, _write_structure_graph

BODY = (
    "Stabilizer codes protect quantum information.\n\n"
    "The generators of S must pairwise commute, otherwise the group contains minus identity.\n\n"
    "A closing paragraph about syndromes.\n"
)
Q1 = "The generators of S must pairwise commute"
Q2 = "A closing paragraph about syndromes."


def _issue(**kw) -> dict:
    base = {
        "type": "coverage", "severity": "major", "description": "Needs a proof.",
        "required_fix": "Add a proof.", "quote": Q1, "replace_from": "", "replace_to": "",
    }
    base.update(kw)
    return base


def _review(*issues: dict, ok: bool = False, edits=("Tighten the intro",), queries=("stabilizer proof",)) -> dict:
    return {"ok_to_keep": ok, "issues": list(issues), "suggested_edits": list(edits), "retrieval_queries": list(queries)}


def _write(work_dir: Path, review: dict | None, body: str = BODY, revised: bool = False) -> None:
    out_dir = work_dir / "out"
    (out_dir / "sections").mkdir(parents=True, exist_ok=True)
    (out_dir / "sections" / "1.md").write_text(body, encoding="utf-8")
    _write_structure_graph(out_dir, nodes={"book": {}, "1": {"title": "Node 0"}}, edges=[["book", "1"]])
    if review is not None:
        reviews = out_dir / "section_reviews"
        reviews.mkdir(parents=True, exist_ok=True)
        (reviews / ("1_revised.json" if revised else "1.json")).write_text(json.dumps(review), encoding="utf-8")


class _Env:
    def __init__(self, session: AsyncSession, project, node, tmp_path: Path) -> None:
        self.session, self.project, self.node = session, project, node
        self.outline = SqlAlchemyOutlineRepository(session)
        self.comments = SqlAlchemyCommentRepository(session)
        self.work = tmp_path / "run"

    async def full(self, run_id: uuid.UUID | None = None) -> None:
        await import_graph(
            self.project, self.work, self.outline, SqlAlchemySourceRepository(self.session),
            comment_repository=self.comments, run_id=run_id,
        )

    async def single(self, run_id: uuid.UUID | None = None) -> None:
        await import_single_node(
            self.project, self.work, self.node.id, self.outline,
            comment_repository=self.comments, run_id=run_id,
        )

    async def rows(self, *, deleted: bool = False) -> list[NodeCommentRecord]:
        self.session.expire_all()
        statement = select(NodeCommentRecord).order_by(NodeCommentRecord.created_at, NodeCommentRecord.id)
        rows = (await self.session.execute(statement)).scalars().all()
        return [r for r in rows if (r.deleted_at is not None) == deleted and r.kind == "review"]


async def _env(session_factory, tmp_path: Path) -> tuple[AsyncSession, _Env]:
    session = session_factory()
    project = await SqlAlchemyProjectRepository(session).add(_make_project())
    node = await SqlAlchemyOutlineRepository(session).add(_make_node(project.id, None, 0, cli_key="1"))
    return session, _Env(session, project, node, tmp_path)


async def test_issues_become_review_rows_with_anchors_and_payload(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    run_id = uuid.uuid4()
    session, env = await _env(session_factory, tmp_path)
    async with session:
        _write(env.work, _review(
            _issue(severity="critical", start=BODY.index(Q1), end=BODY.index(Q1) + len(Q1), replace_from="commute", replace_to="anticommute"),
            _issue(type="clarity", severity="Low", description="Whole section is terse.", quote="", required_fix="Expand."),
            _issue(type="consistency:term", severity="major", description="Uses another term.", quote=Q2),
            _issue(type="coverage", description="Gone quote.", quote="this text does not occur anywhere"),
        ))
        await env.full(run_id)
        rows = await env.rows()
        by_desc = {r.body_markdown: r for r in rows}
        assert len(rows) == 4

        first = by_desc["Needs a proof."]
        assert first.author_id is None and first.thread_id == first.id and first.parent_id is None
        assert first.status == "open"
        assert first.anchor["start"] == BODY.index(Q1) and BODY[first.anchor["start"] : first.anchor["end"]] == Q1
        assert first.payload["severity"] == "major"  # critical folded
        assert first.payload["replaceFrom"] == "commute" and first.payload["replaceTo"] == "anticommute"
        assert first.payload["requiredFix"] == "Add a proof."
        assert first.payload["okToKeep"] is False and first.payload["source"] == "reviewer"
        assert first.payload["runId"] == str(run_id) and first.payload["quote"] == Q1
        assert first.payload["issueKey"] == issue_key("coverage", Q1, "Needs a proof.")

        whole = by_desc["Whole section is terse."]
        assert whole.anchor is None and whole.status == "open" and whole.payload["severity"] == "minor"
        assert by_desc["Uses another term."].payload["source"] == "consistency"
        orphan = by_desc["Gone quote."]
        assert orphan.status == "orphaned" and orphan.anchor["start"] is None

        node = await env.outline.get(env.node.id)
        assert node is not None
        assert node.review_summary["okToKeep"] is False and node.review_summary["issueCount"] == 4
        assert node.review_summary["suggestedEdits"] == ["Tighten the intro"]
        assert node.review_summary["retrievalQueries"] == ["stabilizer proof"]
        assert node.review_summary["runId"] == str(run_id)
        assert node.reviewer_notes and "Needs a proof." in node.reviewer_notes  # legacy field kept


async def test_stale_offsets_are_re_resolved_against_the_imported_text(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    session, env = await _env(session_factory, tmp_path)
    async with session:
        _write(env.work, _review(_issue(start=3, end=3 + len(Q1))))  # offsets of another text
        await env.full()
        (row,) = await env.rows()
        assert BODY[row.anchor["start"] : row.anchor["end"]] == Q1


async def test_reimport_is_idempotent_and_keeps_state_and_replies(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    session, env = await _env(session_factory, tmp_path)
    async with session:
        review = _review(_issue(), _issue(description="Second.", quote=Q2, type="style"))
        _write(env.work, review)
        await env.full()
        await env.full()
        await env.single()
        await env.full(uuid.uuid4())  # a later run, same review
        rows = await env.rows()
        assert len(rows) == 2 and not await env.rows(deleted=True)

        # A user resolves one and replies to the other; a re-import changes neither.
        from api.domain.models import CommentKind, CommentStatus, NodeComment
        from datetime import datetime, timezone
        first, second = sorted(rows, key=lambda r: r.body_markdown)
        now = datetime.now(timezone.utc)
        await env.comments.set_status_many([first.id], CommentStatus.RESOLVED)
        reply_id = uuid.uuid4()
        await env.comments.add(NodeComment(
            id=reply_id, project_id=env.project.id, node_id=env.node.id, kind=CommentKind.COMMENT,
            author_id=None, anchor=None, status=CommentStatus.OPEN, thread_id=second.id, parent_id=second.id,
            body_markdown="agreed", payload={}, created_at=now, updated_at=now,
        ))
        await env.session.commit()
        await env.full()
        rows = {r.id: r for r in await env.rows()}
        assert len(rows) == 2
        assert rows[first.id].status == "resolved"  # a dismissed issue stays dismissed
        assert rows[second.id].status == "open"


async def test_new_review_replaces_untouched_rows_and_keeps_history(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    from datetime import datetime, timezone

    from api.domain.models import CommentKind, CommentStatus, NodeComment

    session, env = await _env(session_factory, tmp_path)
    async with session:
        a, b, c, d = (_issue(description=f"Issue {n}.", quote=q, type=f"t{n}") for n, q in
                      zip("abcd", (Q1, Q2, "Stabilizer codes protect quantum information.", "otherwise the group contains minus identity"), strict=True))
        _write(env.work, _review(a, b, c, d))
        await env.full()
        rows = {r.body_markdown: r for r in await env.rows()}
        now = datetime.now(timezone.utc)
        await env.comments.set_status_many([rows["Issue b."].id], CommentStatus.RESOLVED)
        reply = uuid.uuid4()
        await env.comments.add(NodeComment(
            id=reply, project_id=env.project.id, node_id=env.node.id, kind=CommentKind.COMMENT, author_id=None,
            anchor=None, status=CommentStatus.OPEN, thread_id=rows["Issue c."].id, parent_id=rows["Issue c."].id,
            body_markdown="discussing", payload={}, created_at=now, updated_at=now,
        ))
        await env.session.commit()

        # A later review only reports "a" and a new issue "e".
        e = _issue(description="Issue e.", quote="Stabilizer codes", type="te")
        _write(env.work, _review(a, e))
        await env.full()

        live = {r.body_markdown: r for r in await env.rows()}
        assert set(live) == {"Issue a.", "Issue e.", "Issue b.", "Issue c."}
        assert live["Issue a."].id == rows["Issue a."].id and live["Issue a."].status == "open"
        assert live["Issue b."].status == "resolved"  # resolved: kept as it was
        assert live["Issue c."].status == "resolved" and live["Issue c."].payload["outdated"] is True  # replied: history
        gone = {r.body_markdown: r for r in await env.rows(deleted=True)}
        assert set(gone) == {"Issue d."} and gone["Issue d."].payload["superseded"] is True


async def test_a_deleted_review_card_does_not_come_back_but_a_superseded_one_can(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    session, env = await _env(session_factory, tmp_path)
    async with session:
        a, b = _issue(description="A."), _issue(description="B.", quote=Q2, type="s")
        _write(env.work, _review(a, b))
        await env.full()
        rows = {r.body_markdown: r for r in await env.rows()}
        await env.comments.soft_delete_thread(rows["A."].id)  # the user deletes (dismisses) A

        _write(env.work, _review(a, b))
        await env.full()
        assert {r.body_markdown for r in await env.rows()} == {"B."}  # A stays dismissed

        _write(env.work, _review(a))  # B superseded (untouched)...
        await env.full()
        assert {r.body_markdown for r in await env.rows()} == set()
        _write(env.work, _review(b))  # ...and reported again later: a fresh row
        await env.full()
        assert {r.body_markdown for r in await env.rows()} == {"B."}


async def test_regenerate_one_node_and_a_review_file_without_issues(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    session, env = await _env(session_factory, tmp_path)
    async with session:
        _write(env.work, _review(_issue(), _issue(description="Other.", quote=Q2, type="s")))
        await env.full()
        assert len(await env.rows()) == 2
        # The regenerated section's review reports one issue only.
        _write(env.work, _review(_issue(description="Other.", quote=Q2, type="s")), revised=True)
        await env.single(uuid.uuid4())
        assert {r.body_markdown for r in await env.rows()} == {"Other."}
        # A clean review (no issues) clears the open, untouched rows.
        _write(env.work, _review(ok=True), revised=True)
        await env.single()
        assert await env.rows() == []
        node = await env.outline.get(env.node.id)
        assert node is not None and node.review_summary["okToKeep"] is True and node.review_summary["issueCount"] == 0


async def test_no_review_file_leaves_existing_cards_alone(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    session, env = await _env(session_factory, tmp_path)
    async with session:
        _write(env.work, _review(_issue()))
        await env.full()
        (env.work / "out" / "section_reviews" / "1.json").unlink()
        await env.full()
        assert len(await env.rows()) == 1


async def test_review_rows_follow_a_patch_and_do_not_count_in_badges(
    authed_client: AsyncClient, session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    project_id = (await authed_client.post(
        "/api/v1/projects", json={"title": "T", "subtitle": "S", "authors": ["A"], "topic": "x"}
    )).json()["id"]
    node_id = (await authed_client.post(f"/api/v1/projects/{project_id}/outline", json={"title": "Ch"})).json()["id"]
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).get(uuid.UUID(project_id))
        outline = SqlAlchemyOutlineRepository(session)
        node = await outline.get(uuid.UUID(node_id))
        assert project and node
        await outline.update(__import__("dataclasses").replace(node, cli_key="1"), fields=("cli_key",))
        _write(tmp_path / "run", _review(_issue()))
        await import_graph(
            project, tmp_path / "run", outline, SqlAlchemySourceRepository(session),
            comment_repository=SqlAlchemyCommentRepository(session),
        )
    listed = (await authed_client.get(f"/api/v1/projects/{project_id}/outline/{node_id}/comments?kind=review")).json()
    assert [c["kind"] for c in listed["items"]] == ["review"] and listed["items"][0]["authorId"] is None
    outline_items = (await authed_client.get(f"/api/v1/projects/{project_id}/outline")).json()["items"]
    assert outline_items[0]["openCommentCount"] == 0 and outline_items[0]["pendingSuggestionCount"] == 0
    assert outline_items[0]["reviewSummary"]["issueCount"] == 1

    # The card follows an edit of the text, and "dismiss" is the resolve endpoint.
    shifted = "New opening.\n\n" + BODY
    await authed_client.patch(f"/api/v1/projects/{project_id}/outline/{node_id}", json={"contentMarkdown": shifted})
    card = (await authed_client.get(f"/api/v1/projects/{project_id}/outline/{node_id}/comments?kind=review")).json()["items"][0]
    assert card["anchor"]["start"] == shifted.index(Q1)
    resolved = await authed_client.post(f"/api/v1/comments/{card['id']}/resolve")
    assert resolved.status_code == 200 and resolved.json()["status"] == "resolved"


async def test_generate_mode_import_creates_cards_for_new_nodes(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        _write(tmp_path / "run", _review(_issue()))
        outline = SqlAlchemyOutlineRepository(session)
        comments = SqlAlchemyCommentRepository(session)
        await import_graph(
            project, tmp_path / "run", outline, SqlAlchemySourceRepository(session),
            outline_mode="generate", comment_repository=comments,
        )
        nodes = await outline.list(project.id)
        assert len(nodes) == 1 and nodes[0].review_summary["issueCount"] == 1
        rows = (await session.execute(select(NodeCommentRecord))).scalars().all()
        assert len(rows) == 1 and rows[0].node_id == nodes[0].id
