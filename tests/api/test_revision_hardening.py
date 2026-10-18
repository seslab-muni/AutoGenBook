"""Round-1 review fixes of the revision service (issue #182): one regression
test per finding, built from the reviewer's repro."""
from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.application.graph_import import import_graph
from api.application.revision_apply import content_hash
from api.application.revisions import RevisionRunner, _is_running_index_violation
from api.core.settings import get_settings
from api.domain.models import (
    CommentKind,
    CommentStatus,
    RevisionEvent,
    Run,
    RunKind,
    RunOptions,
    RunStatus,
)
from api.infrastructure.db.comment_repository import SqlAlchemyCommentRepository
from api.infrastructure.db.models import NodeCommentRecord, RevisionEventRecord, RevisionJobRecord
from api.infrastructure.db.outline_repository import SqlAlchemyOutlineRepository
from api.infrastructure.db.repositories import SqlAlchemyProjectRepository
from api.infrastructure.db.revision_repository import SqlAlchemyRevisionRepository
from api.infrastructure.db.run_repository import SqlAlchemyRunRepository
from api.infrastructure.db.source_repository import SqlAlchemySourceRepository
from engine.util.textdiff import diff_hunks
from fake_llm import FakeLLM
from tests.api.conftest import TEST_DATABASE_URL
from tests.api.test_graph_import import _make_node, _make_project, _write_structure_graph
from tests.api.test_revisions import (
    BODY,
    TARGET,
    _add_card,
    _get,
    _node,
    _revise,
    _revisions,
    _setup,
    _start,
    _stream,
)
from tests.api.test_suggestions import _accept, _range_suggestion, _set_content

ON_SQLITE = TEST_DATABASE_URL.startswith("sqlite")
needs_postgres = pytest.mark.skipif(ON_SQLITE, reason="needs real row locks / separate connections")


@pytest_asyncio.fixture
async def session_factory(isolated_session_factory):
    yield isolated_session_factory


def _settings_override(app, runner: RevisionRunner | None = None, **updates):
    settings = get_settings().model_copy(update=updates)
    app.dependency_overrides[get_settings] = lambda: settings
    if runner is not None:
        runner._settings = settings
    return settings


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


async def _pending_card(session_factory, project_id, node_id, original: str, new: str, *, params=None, anchor=None, scope="section"):
    hunks = [h.to_dict() for h in diff_hunks(original, new)]
    payload = {
        "verb": "revise", "scope": scope, "originalMarkdown": original, "replacementMarkdown": new,
        "hunks": hunks, "baseContentHash": content_hash(original), "params": params or {}, "summary": "s",
    }
    if anchor is not None:
        payload["anchor"] = anchor
    row = await _add_card(session_factory, project_id, node_id, CommentKind.SUGGESTION, status=CommentStatus.PENDING, payload=payload, anchor=anchor)
    return str(row), hunks


# ------------------------------------------------- 1. range edit never lost
async def test_small_edit_inside_a_range_is_never_overwritten_by_accept(
    authed_client: AsyncClient, revision_runner: RevisionRunner
) -> None:
    project_id, node_id = await _setup(authed_client)
    done = await _range_suggestion(authed_client, revision_runner, project_id, node_id, quote=TARGET)
    edited = BODY.replace("must pairwise commute", "must all pairwise commute")
    await _set_content(authed_client, project_id, node_id, edited)
    # the suggestion's anchor did not follow the edit fuzzily and its quote is kept
    anchor = (await _get(authed_client, done["id"]))["anchor"]
    assert anchor["start"] is None and anchor["quote"] == TARGET
    response = await authed_client.post(_accept(done["id"]))
    assert response.status_code == 409 and response.json()["code"] == "stale"
    assert (await _node(authed_client, project_id, node_id))["contentMarkdown"] == edited
    assert (await _get(authed_client, done["id"]))["status"] == "pending"


async def test_a_paragraph_break_inside_the_range_makes_accept_stale(
    authed_client: AsyncClient, revision_runner: RevisionRunner
) -> None:
    project_id, node_id = await _setup(authed_client)
    done = await _range_suggestion(authed_client, revision_runner, project_id, node_id, quote=TARGET)
    edited = BODY.replace("must pairwise", "must\n\npairwise")
    await _set_content(authed_client, project_id, node_id, edited)
    response = await authed_client.post(_accept(done["id"]))
    assert response.status_code == 409 and response.json()["code"] == "stale"
    assert (await _node(authed_client, project_id, node_id))["contentMarkdown"] == edited


async def test_an_edit_glued_to_the_range_boundary_makes_accept_stale(
    authed_client: AsyncClient, revision_runner: RevisionRunner
) -> None:
    text = "Intro text here for the section.\n\nThe claim (Lemma 1) is used again in the proof.\n"
    project_id, node_id = await _setup(authed_client, text)
    start = text.index("(Lemma 1)")
    done = await _revise(
        authed_client, revision_runner, project_id, node_id, scope="range",
        anchor={"quote": "(Lemma 1)", "start": start, "end": start + 9},
    )
    assert done["status"] == "pending"
    edited = text.replace("(Lemma 1) is", "(Lemma 1)s is")
    await _set_content(authed_client, project_id, node_id, edited)
    response = await authed_client.post(_accept(done["id"]))
    assert response.status_code == 409 and response.json()["code"] == "stale"
    assert (await _node(authed_client, project_id, node_id))["contentMarkdown"] == edited


# -------------------------------------------- 2. hunks in repetitive text
ROWS = "Intro paragraph.\n\n" + "- the very same list row\n" * 6


@pytest.mark.parametrize(
    "new",
    [
        ROWS.replace("- the very same list row\n", "- the very same list row, changed\n", 3).replace(
            "- the very same list row, changed\n", "- the very same list row\n", 2
        ),
        "Intro paragraph.\n\n" + "- the very same list row\n" * 3 + "- a brand new row\n" + "- the very same list row\n" * 3,
    ],
    ids=["change-in-row-3", "insertion-after-row-3"],
)
async def test_hunks_in_repetitive_text_are_never_placed_by_guesswork(
    authed_client: AsyncClient, session_factory, new: str
) -> None:
    project_id, node_id = await _setup(authed_client, ROWS)
    suggestion_id, hunks = await _pending_card(session_factory, project_id, node_id, ROWS, new)
    assert hunks
    edited = "A paragraph written meanwhile.\n\n" + ROWS
    await _set_content(authed_client, project_id, node_id, edited)
    response = await authed_client.post(_accept(suggestion_id))
    assert response.status_code == 409 and response.json()["code"] == "stale"
    assert (await _node(authed_client, project_id, node_id))["contentMarkdown"] == edited


async def test_unambiguous_hunks_still_apply_after_an_unrelated_edit(
    authed_client: AsyncClient, session_factory
) -> None:
    project_id, node_id = await _setup(authed_client)
    new = BODY.replace("how errors are detected", "how faults show up")
    suggestion_id, _ = await _pending_card(session_factory, project_id, node_id, BODY, new)
    await _set_content(authed_client, project_id, node_id, "New first line.\n\n" + BODY)
    response = await authed_client.post(_accept(suggestion_id))
    assert response.status_code == 200, response.text
    assert response.json()["node"]["contentMarkdown"] == "New first line.\n\n" + new


# ------------------------------------------- 3. content hash / conflicts
async def test_content_hash_is_on_single_node_responses_and_not_in_lists(authed_client: AsyncClient) -> None:
    project_id, node_id = await _setup(authed_client)
    url = f"/api/v1/projects/{project_id}/outline/{node_id}"
    assert (await authed_client.get(url)).json()["contentHash"] == _sha(BODY)
    patched = await authed_client.patch(url, json={"contentMarkdown": BODY + "x"})
    assert patched.json()["contentHash"] == _sha(BODY + "x")
    listed = (await authed_client.get(f"/api/v1/projects/{project_id}/outline")).json()["items"]
    assert listed[0]["contentHash"] is None


async def test_patch_with_a_stale_expected_hash_is_a_content_conflict(authed_client: AsyncClient) -> None:
    project_id, node_id = await _setup(authed_client)
    url = f"/api/v1/projects/{project_id}/outline/{node_id}"
    ok = await authed_client.patch(url, json={"contentMarkdown": BODY + "a", "expectedContentHash": _sha(BODY)})
    assert ok.status_code == 200
    stale = await authed_client.patch(url, json={"contentMarkdown": BODY + "b", "expectedContentHash": _sha(BODY)})
    assert stale.status_code == 409
    body = stale.json()
    assert body["code"] == "content_conflict" and body["currentContentHash"] == _sha(BODY + "a")
    assert (await authed_client.get(url)).json()["contentMarkdown"] == BODY + "a"
    # not a content write: the precondition is not checked
    assert (await authed_client.patch(url, json={"title": "T", "expectedContentHash": _sha(BODY)})).status_code == 200
    assert (await authed_client.patch(url, json={"contentMarkdown": "x", "expectedContentHash": "short"})).status_code == 422


async def test_accept_then_patch_and_patch_then_accept_never_lose_either_side(
    authed_client: AsyncClient, revision_runner: RevisionRunner
) -> None:
    project_id, node_id = await _setup(authed_client)
    url = f"/api/v1/projects/{project_id}/outline/{node_id}"
    h0 = _sha(BODY)
    done = await _revise(authed_client, revision_runner, project_id, node_id)
    accepted = await authed_client.post(_accept(done["id"]), json={"expectedContentHash": h0})
    assert accepted.status_code == 200 and accepted.json()["node"]["contentHash"] == _sha(accepted.json()["node"]["contentMarkdown"])
    late = await authed_client.patch(url, json={"contentMarkdown": BODY + "autosave", "expectedContentHash": h0})
    assert late.status_code == 409 and late.json()["currentContentHash"] == accepted.json()["node"]["contentHash"]

    project_id, node_id = await _setup(authed_client)
    url = f"/api/v1/projects/{project_id}/outline/{node_id}"
    done = await _revise(authed_client, revision_runner, project_id, node_id)
    assert (await authed_client.patch(url, json={"contentMarkdown": BODY + "typed", "expectedContentHash": h0})).status_code == 200
    response = await authed_client.post(_accept(done["id"]), json={"expectedContentHash": h0})
    assert response.status_code == 409 and response.json()["code"] == "content_conflict"
    assert (await authed_client.get(url)).json()["contentMarkdown"] == BODY + "typed"
    assert (await _get(authed_client, done["id"]))["status"] == "pending"


@needs_postgres
async def test_accept_racing_a_save_ends_with_exactly_one_winner(
    authed_client: AsyncClient, revision_runner: RevisionRunner
) -> None:
    for _ in range(8):
        project_id, node_id = await _setup(authed_client)
        url = f"/api/v1/projects/{project_id}/outline/{node_id}"
        done = await _revise(authed_client, revision_runner, project_id, node_id)
        h0 = _sha(BODY)
        typed = BODY + "autosave"
        accept, save = await asyncio.gather(
            authed_client.post(_accept(done["id"]), json={"expectedContentHash": h0}),
            authed_client.patch(url, json={"contentMarkdown": typed, "expectedContentHash": h0}),
        )
        assert sorted([accept.status_code, save.status_code]) == [200, 409], (accept.text, save.text)
        final = (await authed_client.get(url)).json()["contentMarkdown"]
        assert final == (done["payload"]["replacementMarkdown"] if accept.status_code == 200 else typed)


@needs_postgres
async def test_two_simultaneous_accepts_the_loser_is_not_pending(
    authed_client: AsyncClient, revision_runner: RevisionRunner
) -> None:
    for _ in range(4):
        project_id, node_id = await _setup(authed_client)
        done = await _revise(authed_client, revision_runner, project_id, node_id)
        first, second = await asyncio.gather(
            authed_client.post(_accept(done["id"])), authed_client.post(_accept(done["id"]))
        )
        codes = sorted((first.status_code, second.status_code))
        assert codes == [200, 409]
        loser = first if first.status_code == 409 else second
        assert loser.json()["code"] == "not_pending"


# --------------------------------------- 4/5. outcome is always recorded
async def test_cancel_landing_while_the_result_is_recorded_does_not_lose_it(
    authed_client: AsyncClient, revision_runner: RevisionRunner, monkeypatch
) -> None:
    original = revision_runner._finish_pending
    entered = asyncio.Event()

    async def slow(job, result, started):
        entered.set()
        await asyncio.sleep(0.4)
        await original(job, result, started)

    monkeypatch.setattr(revision_runner, "_finish_pending", slow)
    project_id, node_id = await _setup(authed_client)
    card = (await _start(authed_client, project_id, node_id))["suggestion"]
    await asyncio.wait_for(entered.wait(), 10)
    response = await authed_client.post(f"/api/v1/suggestions/{card['id']}/cancel")
    assert response.status_code == 409 and response.json()["code"] == "not_running"
    await revision_runner.wait_idle(5)
    final = await _get(authed_client, card["id"])
    assert final["status"] == "pending" and final["payload"]["replacementMarkdown"]


async def test_shutdown_landing_while_the_result_is_recorded_does_not_lose_it(
    authed_client: AsyncClient, revision_runner: RevisionRunner, monkeypatch
) -> None:
    original = revision_runner._finish_pending
    entered = asyncio.Event()

    async def slow(job, result, started):
        entered.set()
        await asyncio.sleep(0.4)
        await original(job, result, started)

    monkeypatch.setattr(revision_runner, "_finish_pending", slow)
    project_id, node_id = await _setup(authed_client)
    card = (await _start(authed_client, project_id, node_id))["suggestion"]
    await asyncio.wait_for(entered.wait(), 10)
    await revision_runner.aclose()
    final = await _get(authed_client, card["id"])
    assert final["status"] == "pending" and final["payload"]["usage"]


async def test_a_database_error_in_the_final_flush_does_not_lose_the_outcome(
    authed_client: AsyncClient, revision_runner: RevisionRunner, monkeypatch
) -> None:
    async def broken(*args, **kwargs):
        raise RuntimeError("database went away")

    monkeypatch.setattr(revision_runner, "_flush", broken)
    project_id, node_id = await _setup(authed_client)
    done = await _revise(authed_client, revision_runner, project_id, node_id)
    assert done["status"] == "pending"


# ------------------------------------------------------ 6. per-user cap
@needs_postgres
async def test_per_user_cap_holds_under_simultaneous_starts(
    app, authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM
) -> None:
    _settings_override(app, revision_runner, revision_max_per_user=3)
    fake_llm.latency_s = 3.0
    targets = [await _setup(authed_client) for _ in range(6)]
    results = await asyncio.gather(
        *(authed_client.post(_revisions(p, n), json={"instruction": "go"}) for p, n in targets)
    )
    codes = sorted(r.status_code for r in results)
    assert codes == [202, 202, 202, 429, 429, 429], codes


# ----------------------------------------------- 7. malformed review file
async def test_a_malformed_review_never_aborts_the_import(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        outline = SqlAlchemyOutlineRepository(session)
        good = await outline.add(_make_node(project.id, None, 0, cli_key="1"))
        bad = await outline.add(_make_node(project.id, None, 1, cli_key="2"))
        work = tmp_path / "run"
        out = work / "out"
        (out / "sections").mkdir(parents=True)
        (out / "section_reviews").mkdir(parents=True)
        (out / "sections" / "1.md").write_text(BODY, encoding="utf-8")
        (out / "sections" / "2.md").write_text("Second section text.\n", encoding="utf-8")
        _write_structure_graph(out, nodes={"book": {}, "1": {"title": "A"}, "2": {"title": "B"}}, edges=[["book", "1"], ["book", "2"]])
        # a lone surrogate in a quote (json.dumps writes it as an escape) and a string "false"
        (out / "section_reviews" / "1.json").write_text(
            json.dumps({"ok_to_keep": "false", "issues": [{"type": "x", "severity": "major", "description": "d\ud800", "quote": "q\ud800"}]}),
            encoding="utf-8",
        )
        # not even a list
        (out / "section_reviews" / "2.json").write_text(json.dumps({"ok_to_keep": True, "issues": 5}), encoding="utf-8")
        await import_graph(
            project, work, outline, SqlAlchemySourceRepository(session),
            comment_repository=SqlAlchemyCommentRepository(session),
        )
        first = await outline.get(good.id)
        second = await outline.get(bad.id)
        assert first is not None and first.review_summary["okToKeep"] is False and first.review_summary["issueCount"] == 1
        assert second is not None and second.content_markdown == "Second section text.\n"  # imported anyway
        assert second.review_summary is None
        rows = (await session.execute(select(NodeCommentRecord))).scalars().all()
        assert len(rows) == 1 and rows[0].node_id == good.id


# ----------------------------------------------------------- 9. hunkIndexes
async def test_bad_hunk_indexes_are_validation_errors(authed_client: AsyncClient, session_factory) -> None:
    project_id, node_id = await _setup(authed_client)
    new = BODY.replace("protect quantum information", "safeguard quantum data").replace("how errors are detected", "how faults show up")
    suggestion_id, hunks = await _pending_card(session_factory, project_id, node_id, BODY, new)
    for bad in ([len(hunks)], [0, 0], [-1]):
        assert (await authed_client.post(_accept(suggestion_id), json={"hunkIndexes": bad})).status_code == 422


async def test_a_partial_accept_does_not_settle_the_threads_a_full_accept_does(
    authed_client: AsyncClient, session_factory
) -> None:
    project_id, node_id = await _setup(authed_client)
    thread = (await authed_client.post(
        f"/api/v1/projects/{project_id}/outline/{node_id}/comments", json={"bodyMarkdown": "Please fix both."},
    )).json()
    new = BODY.replace("protect quantum information", "safeguard quantum data").replace("how errors are detected", "how faults show up")
    params = {"addressCommentIds": [thread["id"]]}
    first, hunks = await _pending_card(session_factory, project_id, node_id, BODY, new, params=params)
    assert len(hunks) >= 2
    assert (await authed_client.post(_accept(first), json={"hunkIndexes": [0]})).status_code == 200
    assert (await _get(authed_client, thread["id"]))["status"] == "open"
    second, hunks2 = await _pending_card(session_factory, project_id, node_id, (await _node(authed_client, project_id, node_id))["contentMarkdown"], new, params=params)
    assert (await authed_client.post(_accept(second), json={"hunkIndexes": list(range(len(hunks2)))})).status_code == 200
    assert (await _get(authed_client, thread["id"]))["status"] == "resolved"


# ------------------------------------------------------------ 10. migration
def test_migration_declares_the_partial_index_for_sqlite_too() -> None:
    source = (Path(__file__).resolve().parents[2] / "api/infrastructure/db/alembic/versions/0025_revision_jobs.py").read_text()
    assert "sqlite_where=where" in source


# ------------------------------------------------------------------- 11. SSE
async def test_sse_terminal_event_never_overtakes_the_last_progress_events(
    authed_client: AsyncClient, session_factory, monkeypatch
) -> None:
    project_id, node_id = await _setup(authed_client)
    cid = await _add_card(session_factory, project_id, node_id, CommentKind.SUGGESTION, status=CommentStatus.RUNNING, payload={})
    original = SqlAlchemyRevisionRepository.list_events
    state = {"done": False}

    async def hooked(self, comment_id, after_seq, *, limit):
        result = await original(self, comment_id, after_seq, limit=limit)
        if not state["done"]:
            state["done"] = True  # the job writes its last events and finishes right after this read
            async with session_factory() as session:
                repo = SqlAlchemyRevisionRepository(session)
                now = datetime.now(timezone.utc)
                await repo.append_events(cid, [RevisionEvent(seq=i, ts=now, level="info", stage="revise", message=f"m{i}") for i in (1, 2, 3)])
                await session.execute(update(NodeCommentRecord).where(NodeCommentRecord.id == cid).values(status="pending"))
                await session.commit()
        return result

    monkeypatch.setattr(SqlAlchemyRevisionRepository, "list_events", hooked)
    events = await _stream(authed_client, str(cid))
    assert [e[0] for e in events] == ["progress", "progress", "progress", "done"]


def test_openapi_documents_the_stream_event_schemas() -> None:
    from api.main import create_app

    schemas = create_app().openapi()["components"]["schemas"]
    assert {"SuggestionProgress", "SuggestionTerminal"} <= set(schemas)


# -------------------------------------------------------------- 12. reasoning
async def test_the_environments_reasoning_effort_reaches_the_model_call(
    authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM
) -> None:
    revision_runner._env = {**revision_runner._env, "AUTOGENBOOK_LLM_REASONING_EFFORT": "none"}
    project_id, node_id = await _setup(authed_client)
    await _revise(authed_client, revision_runner, project_id, node_id)
    assert fake_llm.chat_calls("SectionRevision")[0].body.get("reasoning_effort") == "none"


# ------------------------------------------------------ 13. retrieval safety
def _run_row(project_id: str, kind: RunKind, work_dir: Path, age_s: int) -> Run:
    return Run(
        id=uuid.uuid4(), project_id=uuid.UUID(project_id), kind=kind, status=RunStatus.succeeded,
        options=RunOptions(outline="project"), base_run_id=None, target_node_id=None, target_node_previous_status=None,
        work_dir=str(work_dir), exit_code=0, error=None, cancel_requested=False, locked_by=None, heartbeat_at=None,
        queued_at=datetime.now(timezone.utc) - timedelta(seconds=age_s), started_at=None, finished_at=None,
        total_tokens=None, total_cost_usd=None,
    )


async def test_oversized_index_is_skipped_with_a_warning(
    app, authed_client: AsyncClient, revision_runner: RevisionRunner, session_factory, tmp_path: Path, monkeypatch
) -> None:
    import api.application.revisions as revisions

    calls = []

    async def loader(work_dir, **kwargs):
        calls.append(work_dir)

    monkeypatch.setattr(revisions, "load_revision_retrieval", loader)
    runs_dir = tmp_path / "runs"
    cache = runs_dir / "w" / "out" / ".kb_cache"
    cache.mkdir(parents=True)
    (cache / "engine_kb_abc.pkl").write_bytes(b"x" * 500)
    _settings_override(app, revision_runner, runs_dir=str(runs_dir), revision_max_kb_bytes=100)
    project_id, node_id = await _setup(authed_client)
    async with session_factory() as session:
        await SqlAlchemyRunRepository(session).add(_run_row(project_id, RunKind.full, runs_dir / "w", 10))
    done = await _revise(authed_client, revision_runner, project_id, node_id)
    assert done["status"] == "pending" and calls == []
    assert "sources too large to search during a revision" in done["payload"]["warnings"]


async def test_a_burst_of_export_runs_does_not_hide_the_knowledge_base(
    app, authed_client: AsyncClient, revision_runner: RevisionRunner, session_factory, tmp_path: Path, monkeypatch
) -> None:
    import api.application.revisions as revisions

    calls = []

    async def loader(work_dir, **kwargs):
        calls.append(Path(work_dir))

    monkeypatch.setattr(revisions, "load_revision_retrieval", loader)
    runs_dir = tmp_path / "runs"
    (runs_dir / "full" / "out" / ".kb_cache").mkdir(parents=True)
    _settings_override(app, revision_runner, runs_dir=str(runs_dir))
    project_id, node_id = await _setup(authed_client)
    async with session_factory() as session:
        repo = SqlAlchemyRunRepository(session)
        await repo.add(_run_row(project_id, RunKind.full, runs_dir / "full", 1000))
        for i in range(15):
            await repo.add(_run_row(project_id, RunKind.export, runs_dir / "full", 10 + i))
    done = await _revise(authed_client, revision_runner, project_id, node_id)
    assert done["status"] == "pending" and calls == [(runs_dir / "full").resolve()]


# ------------------------------------------------------------- 14. size limits
async def test_big_sections_are_revised_by_selection_and_rewrite_has_the_instruction_cap(
    app, authed_client: AsyncClient, revision_runner: RevisionRunner
) -> None:
    _settings_override(app, revision_runner, revision_max_section_chars=50)
    project_id, node_id = await _setup(authed_client)
    response = await authed_client.post(_revisions(project_id, node_id), json={"instruction": "x"})
    assert response.status_code == 409 and response.json()["code"] == "section_too_large"
    assert "select" in response.json()["detail"]
    start = BODY.index(TARGET)
    ranged = await authed_client.post(
        _revisions(project_id, node_id),
        json={"instruction": "x", "scope": "range", "anchor": {"quote": TARGET, "start": start, "end": start + len(TARGET)}},
    )
    assert ranged.status_code == 202
    too_long = await authed_client.post(_revisions(project_id, node_id), json={"verb": "rewrite", "instruction": "x" * 4001})
    assert too_long.status_code == 422


# ---------------------------------------------------- 15. trimming and purge
async def test_node_list_trims_finished_suggestions_but_not_pending_ones(
    authed_client: AsyncClient, revision_runner: RevisionRunner
) -> None:
    project_id, node_id = await _setup(authed_client)
    rejected = await _revise(authed_client, revision_runner, project_id, node_id)
    await authed_client.post(f"/api/v1/suggestions/{rejected['id']}/reject")
    pending = await _revise(authed_client, revision_runner, project_id, node_id)
    listed = {c["id"]: c for c in (await authed_client.get(f"/api/v1/projects/{project_id}/outline/{node_id}/comments")).json()["items"]}
    assert "originalMarkdown" not in listed[rejected["id"]]["payload"] and listed[rejected["id"]]["payload"]["hunks"]
    assert listed[rejected["id"]]["payload"]["summary"]
    assert listed[pending["id"]]["payload"]["replacementMarkdown"]
    assert (await _get(authed_client, rejected["id"]))["payload"]["replacementMarkdown"]


async def test_the_sweep_purges_old_events_and_job_rows(
    app, authed_client: AsyncClient, revision_runner: RevisionRunner, session_factory
) -> None:
    _settings_override(app, revision_runner, revision_events_keep_s=0)
    project_id, node_id = await _setup(authed_client)
    done = await _revise(authed_client, revision_runner, project_id, node_id)
    async with session_factory() as session:
        assert (await session.execute(select(RevisionEventRecord))).scalars().all()
    await asyncio.sleep(0.05)
    await revision_runner.sweep_once()
    async with session_factory() as session:
        assert (await session.execute(select(RevisionEventRecord))).scalars().all() == []
        assert (await session.execute(select(RevisionJobRecord))).scalars().all() == []
    assert (await _get(authed_client, done["id"]))["status"] == "pending"


# ------------------------------------------------------------------ 17. nits
def test_only_the_running_index_means_already_running() -> None:
    class Orig(Exception):
        pass

    assert _is_running_index_violation(IntegrityError("s", {}, Orig('duplicate key value violates unique constraint "uq_node_comments_running_suggestion"')))
    assert _is_running_index_violation(IntegrityError("s", {}, Orig("UNIQUE constraint failed: node_comments.node_id")))
    assert not _is_running_index_violation(IntegrityError("s", {}, Orig('insert or update on table "node_comments" violates foreign key constraint "fk_node_comments_author_id_users"')))


async def test_deleting_a_running_suggestion_ends_terminal_and_keeps_its_usage(
    authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM, session_factory
) -> None:
    fake_llm.latency_s = 5.0
    project_id, node_id = await _setup(authed_client)
    card = (await _start(authed_client, project_id, node_id))["suggestion"]
    await asyncio.sleep(0.4)
    assert (await authed_client.delete(f"/api/v1/comments/{card['id']}")).status_code == 204
    await revision_runner.wait_idle(5)
    async with session_factory() as session:
        row = await SqlAlchemyCommentRepository(session).get(uuid.UUID(card["id"]), include_deleted=True)
    assert row is not None and row.deleted_at is not None
    assert row.status == CommentStatus.CANCELLED and row.payload["finishedAt"]
    assert row.payload["instruction"] == "Add a short proof."


async def test_a_job_stops_when_its_node_is_deleted(
    authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM, session_factory
) -> None:
    fake_llm.latency_s = 5.0
    project_id, node_id = await _setup(authed_client)
    card = (await _start(authed_client, project_id, node_id))["suggestion"]
    await asyncio.sleep(0.4)
    assert (await authed_client.delete(f"/api/v1/projects/{project_id}/outline/{node_id}")).status_code == 204
    await revision_runner.wait_idle(5)
    assert revision_runner.running_jobs == 0
    async with session_factory() as session:
        row = await SqlAlchemyCommentRepository(session).get(uuid.UUID(card["id"]), include_deleted=True)
    assert row is not None and row.status == CommentStatus.CANCELLED


# -------------------------------------------------------------- 18. lifespan
async def test_the_real_lifespan_recovers_on_startup_and_closes_the_runner(
    app, authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM, session_factory
) -> None:
    project_id, node_id = await _setup(authed_client)
    orphan = await _add_card(session_factory, project_id, node_id, CommentKind.SUGGESTION, status=CommentStatus.RUNNING, payload={"instruction": "left behind"})
    async with session_factory() as session:
        await SqlAlchemyRevisionRepository(session).add_job(orphan, "testhost:previous-process")
        await session.commit()
    other_project, other_node = await _setup(authed_client)
    fake_llm.latency_s = 5.0
    async with app.router.lifespan_context(app):
        assert (await _get(authed_client, str(orphan)))["payload"]["error"]["code"] == "interrupted"
        card = (await _start(authed_client, other_project, other_node))["suggestion"]
        await asyncio.sleep(0.3)
        assert revision_runner.running_jobs == 1 and revision_runner._sweeper is not None
    assert revision_runner.running_jobs == 0 and revision_runner._pool is None and revision_runner._sweeper is None
    final = await _get(authed_client, card["id"])
    assert final["status"] == "failed" and final["payload"]["error"]["code"] == "interrupted"


# ----------------------------------- R2-1/5. a copy of the quote is not the range
SENTENCE = "The generators of S must pairwise commute."
REPEATS = [
    pytest.param(SENTENCE, id="sentence"),
    pytest.param("minus identity", id="short-phrase"),
    pytest.param("$\\sigma^2 = 1$", id="formula"),
]


def _twice(quote: str) -> str:
    return f"Theorem. {quote} Proof sketch of several statements.\n\nRecall: {quote} Done.\n"


@pytest.mark.parametrize("quote", REPEATS)
@pytest.mark.parametrize("edit", ["edit", "delete"])
async def test_a_suggestion_never_moves_to_another_copy_of_its_quote(
    authed_client: AsyncClient, revision_runner: RevisionRunner, quote: str, edit: str
) -> None:
    content = _twice(quote)
    project_id, node_id = await _setup(authed_client, content)
    second = content.rindex(quote)
    # exact offsets, no prefix/suffix (R2-5): enough to select the second copy
    done = await _revise(
        authed_client, revision_runner, project_id, node_id, scope="range",
        anchor={"quote": quote, "start": second, "end": second + len(quote)},
    )
    assert done["status"] == "pending" and done["anchor"]["start"] == second
    changed = quote[:3] + "X" + quote[3:] if edit == "edit" else ""
    edited = content[:second] + changed + content[second + len(quote):]
    await _set_content(authed_client, project_id, node_id, edited)
    assert (await _get(authed_client, done["id"]))["anchor"]["start"] is None  # orphaned, not moved to the first copy
    response = await authed_client.post(_accept(done["id"]))
    assert response.status_code == 409 and response.json()["code"] == "stale"
    assert (await _node(authed_client, project_id, node_id))["contentMarkdown"] == edited


async def test_a_suggestion_on_a_repeated_quote_still_applies_to_the_selected_copy(
    authed_client: AsyncClient, revision_runner: RevisionRunner
) -> None:
    content = _twice(SENTENCE)
    project_id, node_id = await _setup(authed_client, content)
    second = content.rindex(SENTENCE)
    done = await _revise(
        authed_client, revision_runner, project_id, node_id, scope="range",
        anchor={"quote": SENTENCE, "start": second, "end": second + len(SENTENCE)},
    )
    await _set_content(authed_client, project_id, node_id, "A new opening paragraph.\n\n" + content)
    response = await authed_client.post(_accept(done["id"]))
    assert response.status_code == 200, response.text
    result = response.json()["node"]["contentMarkdown"]
    assert result.startswith("A new opening paragraph.\n\nTheorem. " + SENTENCE + " Proof sketch")
    assert "Recall: " + SENTENCE + " An added proof sentence (revised)." in result


async def test_a_duplicate_that_slid_onto_the_stored_offsets_is_refused() -> None:
    from api.application.revision_apply import StaleSuggestion, apply_revision

    original = "Alpha. Same sentence here. Omega.\n"
    start = original.index("Same")
    quote = "Same sentence here."
    payload = {
        "scope": "range", "originalMarkdown": original, "replacementMarkdown": original.replace(quote, "NEW"),
        "hunks": [], "baseContentHash": content_hash(original), "anchorUnique": True,
        "anchor": {"quote": quote, "start": start, "end": start + len(quote)},
    }
    stored = {"quote": quote, "prefix": "Alpha. ", "suffix": " Omega.\n", "start": start, "end": start + len(quote)}
    # the selected sentence was rewritten and an identical copy now sits at the stored offsets
    current = "Beta. Same sentence here. Zeta. Same sentence here.\n"
    with pytest.raises(StaleSuggestion):
        apply_revision(current, payload, {**stored, "start": current.index("Same"), "end": current.index("Same") + len(quote)})


# ------------------------------------------------------------- R2-2 deadlocks
@needs_postgres
async def test_a_reply_does_not_deadlock_with_a_save(
    authed_client: AsyncClient, monkeypatch
) -> None:
    import api.application.outline as outline_module

    project_id, node_id = await _setup(authed_client)
    root = (await authed_client.post(
        f"/api/v1/projects/{project_id}/outline/{node_id}/comments",
        json={"bodyMarkdown": "root", "anchor": {"quote": TARGET}},
    )).json()
    original = outline_module.reanchor_node_cards

    async def slow(*args, **kwargs):
        await asyncio.sleep(0.8)  # the save holds the node lock and is about to want the root
        return await original(*args, **kwargs)

    monkeypatch.setattr(outline_module, "reanchor_node_cards", slow)
    save = asyncio.create_task(authed_client.patch(
        f"/api/v1/projects/{project_id}/outline/{node_id}", json={"contentMarkdown": "Prefix. " + BODY}
    ))
    await asyncio.sleep(0.3)
    reply = asyncio.create_task(authed_client.post(
        f"/api/v1/projects/{project_id}/outline/{node_id}/comments", json={"bodyMarkdown": "reply", "parentId": root["id"]}
    ))
    results = await asyncio.gather(save, reply, return_exceptions=True)
    assert [getattr(r, "status_code", r) for r in results] == [200, 201]


@needs_postgres
async def test_a_reply_does_not_deadlock_with_a_revision_started_in_its_thread(
    authed_client: AsyncClient, revision_runner: RevisionRunner, monkeypatch
) -> None:
    from api.application.revisions import RevisionService

    project_id, node_id = await _setup(authed_client)
    root = (await authed_client.post(
        f"/api/v1/projects/{project_id}/outline/{node_id}/comments", json={"bodyMarkdown": "root"},
    )).json()
    original = RevisionService._llm_settings

    async def slow(self, project, user):
        await asyncio.sleep(0.8)  # the start holds the user lock and is about to want the root
        return await original(self, project, user)

    monkeypatch.setattr(RevisionService, "_llm_settings", slow)
    start = asyncio.create_task(authed_client.post(
        _revisions(project_id, node_id), json={"instruction": "x", "threadId": root["id"]}
    ))
    await asyncio.sleep(0.3)
    reply = asyncio.create_task(authed_client.post(
        f"/api/v1/projects/{project_id}/outline/{node_id}/comments", json={"bodyMarkdown": "reply", "parentId": root["id"]}
    ))
    results = await asyncio.gather(start, reply, return_exceptions=True)
    assert [getattr(r, "status_code", r) for r in results] == [202, 201]


# ---------------------------------------------- R2-3/4/9. cancel and shutdown
async def test_cancel_landing_during_the_flusher_teardown_does_not_lose_the_outcome(
    authed_client: AsyncClient, revision_runner: RevisionRunner, monkeypatch
) -> None:
    tearing_down = asyncio.Event()

    async def slow_flusher(job, sink, work):
        try:
            while not work.done():
                await asyncio.sleep(0.02)
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            tearing_down.set()
            await asyncio.sleep(0.4)
            raise

    monkeypatch.setattr(revision_runner, "_flush_loop", slow_flusher)
    project_id, node_id = await _setup(authed_client)
    card = (await _start(authed_client, project_id, node_id))["suggestion"]
    await asyncio.wait_for(tearing_down.wait(), 10)
    await revision_runner.aclose()  # a shutdown landing in the middle of the teardown
    final = await _get(authed_client, card["id"])
    assert final["status"] == "pending" and final["payload"]["replacementMarkdown"]
    assert revision_runner._records == set()


async def test_double_cancel_ends_cancelled_not_failed(
    authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM
) -> None:
    fake_llm.latency_s = 5.0
    project_id, node_id = await _setup(authed_client)
    card = (await _start(authed_client, project_id, node_id))["suggestion"]
    await asyncio.sleep(0.3)
    cid = uuid.UUID(card["id"])
    first = asyncio.create_task(revision_runner.cancel_local(cid))
    await asyncio.sleep(0)
    second = asyncio.create_task(revision_runner.cancel_local(cid))  # a double click
    await asyncio.gather(first, second)
    await revision_runner.wait_idle(5)
    final = await _get(authed_client, card["id"])
    assert final["status"] == "cancelled" and "error" not in final["payload"]


async def test_two_cancel_requests_both_end_cancelled(
    authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM
) -> None:
    fake_llm.latency_s = 5.0
    project_id, node_id = await _setup(authed_client)
    card = (await _start(authed_client, project_id, node_id))["suggestion"]
    await asyncio.sleep(0.3)
    results = await asyncio.gather(
        authed_client.post(f"/api/v1/suggestions/{card['id']}/cancel"),
        authed_client.post(f"/api/v1/suggestions/{card['id']}/cancel"),
    )
    assert [r.status_code for r in results] == [200, 200]
    assert (await _get(authed_client, card["id"]))["status"] == "cancelled"


# --------------------------------------------------------------- R2-7/8 inputs
async def test_malformed_hunks_on_the_hash_match_path_are_a_409_not_a_500(
    authed_client: AsyncClient, session_factory
) -> None:
    project_id, node_id = await _setup(authed_client)
    row = await _add_card(
        session_factory, project_id, node_id, CommentKind.SUGGESTION, status=CommentStatus.PENDING,
        payload={"scope": "section", "originalMarkdown": BODY, "replacementMarkdown": "x", "baseContentHash": content_hash(BODY),
                 "hunks": [{"start": 0, "end": 3, "removed": "zzz", "added": "y"}, {"start": 5, "end": 6, "removed": "q", "added": ""}]},
    )
    response = await authed_client.post(_accept(str(row)), json={"hunkIndexes": [0]})
    assert response.status_code == 409 and response.json()["code"] == "invalid_suggestion"


async def test_expected_content_hash_format_and_null_content(authed_client: AsyncClient) -> None:
    project_id, node_id = await _setup(authed_client)
    url = f"/api/v1/projects/{project_id}/outline/{node_id}"
    for bad in ("A" * 64, "g" * 64, _sha(BODY).upper()):
        assert (await authed_client.patch(url, json={"contentMarkdown": "x", "expectedContentHash": bad})).status_code == 422
        assert (await authed_client.post(_accept(str(uuid.uuid4())), json={"expectedContentHash": bad})).status_code == 422
    assert (await authed_client.patch(url, json={"contentMarkdown": None})).status_code == 422
    # checked whenever contentMarkdown is present, even when the text is identical
    stale = await authed_client.patch(url, json={"contentMarkdown": BODY, "expectedContentHash": _sha("other")})
    assert stale.status_code == 409 and stale.json()["code"] == "content_conflict"
    assert (await authed_client.patch(url, json={"contentMarkdown": ""})).status_code == 200


# ----------------------------------------------------------------- R2-10
async def test_accept_re_reads_the_suggestion_after_taking_the_node_lock(
    authed_client: AsyncClient, revision_runner: RevisionRunner, monkeypatch
) -> None:
    """B reads the pending suggestion, pauses before the lock; A accepts meanwhile.
    A stale pre-lock read would let B try to apply it to the changed text and
    answer `stale`; B must see that it is no longer pending."""
    project_id, node_id = await _setup(authed_client)
    done = await _range_suggestion(authed_client, revision_runner, project_id, node_id, quote=TARGET)
    original = SqlAlchemyOutlineRepository.get_for_update
    calls = {"n": 0}

    async def paused(self, node_id):
        calls["n"] += 1
        if calls["n"] == 1:
            await asyncio.sleep(0.6)
        return await original(self, node_id)

    monkeypatch.setattr(SqlAlchemyOutlineRepository, "get_for_update", paused)
    slow = asyncio.create_task(authed_client.post(_accept(done["id"])))
    await asyncio.sleep(0.2)
    fast = await authed_client.post(_accept(done["id"]))
    loser = await slow
    assert fast.status_code == 200 and loser.status_code == 409
    assert loser.json()["code"] == "not_pending"
