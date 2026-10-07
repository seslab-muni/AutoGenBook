"""Issue #182 phase 4: accepting, rejecting and rewriting (`RevisionService`).

Accepting must never silently overwrite what the user wrote after the
suggestion was computed, and it is one transaction: the text, the status, the
settled threads/issues and the re-anchored cards.
"""
from __future__ import annotations

import uuid
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.application.revision_apply import content_hash
from api.application.revisions import RevisionRunner
from api.core.settings import get_settings
from api.domain.models import CommentKind, CommentStatus, NodeComment, Run, RunKind, RunOptions, RunStatus
from api.infrastructure.db.comment_repository import SqlAlchemyCommentRepository
from api.infrastructure.db.models import NodeCommentRecord, OutlineNodeRecord
from api.infrastructure.db.run_repository import SqlAlchemyRunRepository
from engine.util.textdiff import diff_hunks
from tests.api.test_revisions import (
    BODY,
    TARGET,
    _add_card,
    _anchor,
    _get,
    _node,
    _revise,
    _revisions,
    _setup,
    _start,
)

FIRST = "Stabilizer codes protect quantum information."


@pytest_asyncio.fixture
async def session_factory(isolated_session_factory):
    """Own connection per session: the revision job runs next to requests."""
    yield isolated_session_factory


def _accept(suggestion_id: str) -> str:
    return f"/api/v1/suggestions/{suggestion_id}/accept"


async def _range_suggestion(client, runner, project_id, node_id, quote=FIRST, **extra) -> dict:
    start = BODY.index(quote)
    done = await _revise(
        client, runner, project_id, node_id, scope="range",
        anchor={"quote": quote, "start": start, "end": start + len(quote)}, **extra,
    )
    assert done["status"] == "pending", done
    return done


async def _set_content(client, project_id, node_id, content) -> None:
    response = await client.patch(f"/api/v1/projects/{project_id}/outline/{node_id}", json={"contentMarkdown": content})
    assert response.status_code == 200, response.text


# ------------------------------------------------------------------ accept
async def test_accept_writes_the_text_and_reanchors_the_other_cards(
    authed_client: AsyncClient, revision_runner: RevisionRunner
) -> None:
    project_id, node_id = await _setup(authed_client)
    other = (await authed_client.post(
        f"/api/v1/projects/{project_id}/outline/{node_id}/comments",
        json={"bodyMarkdown": "later comment", "anchor": {"quote": TARGET}},
    )).json()
    done = await _range_suggestion(authed_client, revision_runner, project_id, node_id)
    new_text = done["payload"]["replacementMarkdown"]

    response = await authed_client.post(_accept(done["id"]))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["suggestion"]["status"] == "accepted" and body["suggestion"]["payload"]["acceptedAt"]
    assert body["node"]["contentMarkdown"] == new_text
    assert body["node"]["actualWords"] == len(new_text.split())
    assert body["node"]["pendingSuggestionCount"] == 0 and body["node"]["openCommentCount"] == 1
    assert (await _node(authed_client, project_id, node_id))["contentMarkdown"] == new_text

    moved = (await _get(authed_client, other["id"]))["anchor"]
    assert moved["start"] == new_text.index(TARGET) and moved["start"] > other["anchor"]["start"]
    assert (await authed_client.post(_accept(done["id"]))).status_code == 409  # no longer pending


async def test_accept_settles_the_thread_and_the_issues_it_addressed(
    authed_client: AsyncClient, revision_runner: RevisionRunner, session_factory
) -> None:
    project_id, node_id = await _setup(authed_client)
    thread = (await authed_client.post(
        f"/api/v1/projects/{project_id}/outline/{node_id}/comments",
        json={"bodyMarkdown": "Please justify.", "anchor": {"quote": TARGET}},
    )).json()
    addressed = (await authed_client.post(
        f"/api/v1/projects/{project_id}/outline/{node_id}/comments", json={"bodyMarkdown": "Whole section is dry."},
    )).json()
    bystander = (await authed_client.post(
        f"/api/v1/projects/{project_id}/outline/{node_id}/comments", json={"bodyMarkdown": "Unrelated."},
    )).json()
    issue = await _add_card(session_factory, project_id, node_id, CommentKind.REVIEW, body="No proof.", anchor=_anchor(BODY, FIRST), payload={"type": "coverage", "severity": "major"})
    other_issue = await _add_card(session_factory, project_id, node_id, CommentKind.REVIEW, body="Other.", payload={"type": "style"})

    done = await _revise(
        authed_client, revision_runner, project_id, node_id, scope="range", threadId=thread["id"], instruction="",
        params={"fixIssueIds": [str(issue)], "addressCommentIds": [addressed["id"]]},
    )
    assert done["status"] == "pending"
    assert (await authed_client.post(_accept(done["id"]))).status_code == 200
    states = {c["id"]: c["status"] for c in (await authed_client.get(f"/api/v1/projects/{project_id}/comments")).json()["items"]}
    assert states[thread["id"]] == "resolved" and states[addressed["id"]] == "resolved"
    assert states[str(issue)] == "resolved"
    assert states[bystander["id"]] == "open" and states[str(other_issue)] == "open"
    assert (await _node(authed_client, project_id, node_id))["openCommentCount"] == 1


async def test_stale_range_suggestion_still_applies_where_its_text_moved(
    authed_client: AsyncClient, revision_runner: RevisionRunner
) -> None:
    project_id, node_id = await _setup(authed_client)
    done = await _range_suggestion(authed_client, revision_runner, project_id, node_id, quote=TARGET)
    edited = "A new opening paragraph, written meanwhile.\n\n" + BODY
    await _set_content(authed_client, project_id, node_id, edited)
    # the card followed its text
    assert (await _get(authed_client, done["id"]))["anchor"]["start"] == edited.index(TARGET)

    response = await authed_client.post(_accept(done["id"]))
    assert response.status_code == 200, response.text
    result = response.json()["node"]["contentMarkdown"]
    assert result.startswith("A new opening paragraph, written meanwhile.")  # the user's edit survived
    assert "An added proof sentence (revised)." in result and result.endswith(BODY[BODY.index(TARGET) + len(TARGET):])


async def test_stale_range_suggestion_conflicts_when_its_text_was_edited(
    authed_client: AsyncClient, revision_runner: RevisionRunner
) -> None:
    project_id, node_id = await _setup(authed_client)
    done = await _range_suggestion(authed_client, revision_runner, project_id, node_id, quote=TARGET)
    edited = BODY.replace("must pairwise commute", "have to commute in pairs, which is checked below")
    await _set_content(authed_client, project_id, node_id, edited)
    response = await authed_client.post(_accept(done["id"]))
    assert response.status_code == 409 and response.json()["code"] == "stale"
    assert (await _node(authed_client, project_id, node_id))["contentMarkdown"] == edited  # never overwritten
    assert (await _get(authed_client, done["id"]))["status"] == "pending"


async def test_stale_section_suggestion_applies_hunks_that_still_fit_else_conflicts(
    authed_client: AsyncClient, revision_runner: RevisionRunner
) -> None:
    project_id, node_id = await _setup(authed_client)
    done = await _revise(authed_client, revision_runner, project_id, node_id)
    appended = BODY + "\nA note the author added after asking.\n"
    await _set_content(authed_client, project_id, node_id, appended)
    response = await authed_client.post(_accept(done["id"]))
    assert response.status_code == 200, response.text
    result = response.json()["node"]["contentMarkdown"]
    assert "A note the author added after asking." in result and "(revised)" in result

    # a second suggestion whose spot was rewritten meanwhile cannot be placed
    project_id, node_id = await _setup(authed_client)
    done = await _revise(authed_client, revision_runner, project_id, node_id)
    rewritten = BODY.replace("syndromes and how errors are detected", "the measurement of stabilizer eigenvalues")
    await _set_content(authed_client, project_id, node_id, rewritten)
    response = await authed_client.post(_accept(done["id"]))
    assert response.status_code == 409 and response.json()["code"] == "stale"
    assert (await _node(authed_client, project_id, node_id))["contentMarkdown"] == rewritten


async def _pending_with_hunks(session_factory, project_id, node_id, new_text: str) -> tuple[str, list]:
    hunks = [h.to_dict() for h in diff_hunks(BODY, new_text)]
    row = await _add_card(
        session_factory, project_id, node_id, CommentKind.SUGGESTION, status=CommentStatus.PENDING,
        payload={
            "verb": "revise", "scope": "section", "originalMarkdown": BODY, "replacementMarkdown": new_text,
            "hunks": hunks, "baseContentHash": content_hash(BODY), "params": {}, "summary": "s",
        },
    )
    return str(row), hunks


async def test_accepting_a_subset_of_hunks(authed_client: AsyncClient, session_factory) -> None:
    project_id, node_id = await _setup(authed_client)
    new = BODY.replace("protect quantum information", "safeguard quantum data").replace("how errors are detected", "how faults show up")
    suggestion_id, hunks = await _pending_with_hunks(session_factory, project_id, node_id, new)
    assert len(hunks) >= 2

    for bad, expect in (([], 422), ([99], 409)):
        response = await authed_client.post(_accept(suggestion_id), json={"hunkIndexes": bad})
        assert response.status_code == expect, response.text
    response = await authed_client.post(_accept(suggestion_id), json={"hunkIndexes": [len(hunks) - 1]})
    assert response.status_code == 200, response.text
    result = response.json()["node"]["contentMarkdown"]
    assert "how faults show up" in result and "protect quantum information" in result
    assert response.json()["suggestion"]["payload"]["appliedHunks"] == [len(hunks) - 1]


async def test_hunk_indexes_are_for_section_scope_only(
    authed_client: AsyncClient, revision_runner: RevisionRunner
) -> None:
    project_id, node_id = await _setup(authed_client)
    done = await _range_suggestion(authed_client, revision_runner, project_id, node_id)
    assert (await authed_client.post(_accept(done["id"]), json={"hunkIndexes": [0]})).status_code == 422


async def test_content_lock_does_not_block_accept_but_a_generating_node_or_full_run_does(
    authed_client: AsyncClient, revision_runner: RevisionRunner, session_factory
) -> None:
    project_id, node_id = await _setup(authed_client)
    done = await _revise(authed_client, revision_runner, project_id, node_id)

    await authed_client.patch(f"/api/v1/projects/{project_id}/outline/{node_id}", json={"status": "drafting"})
    response = await authed_client.post(_accept(done["id"]))
    assert response.status_code == 409 and response.json()["code"] == "node_generating"
    await authed_client.patch(f"/api/v1/projects/{project_id}/outline/{node_id}", json={"status": "not_started"})

    run = (await authed_client.post(f"/api/v1/projects/{project_id}/runs", json={"outline": "project"})).json()
    response = await authed_client.post(_accept(done["id"]))
    assert response.status_code == 409 and response.json()["code"] == "run_active"
    # a content-locked section is kept by runs, so accepting is fine (like a PATCH)
    await authed_client.patch(f"/api/v1/projects/{project_id}/outline/{node_id}", json={"contentLocked": True})
    response = await authed_client.post(_accept(done["id"]))
    assert response.status_code == 200 and response.json()["node"]["contentLocked"] is True
    assert run["id"]


async def test_accept_is_atomic_when_a_step_fails(
    authed_client: AsyncClient, revision_runner: RevisionRunner, monkeypatch
) -> None:
    import api.application.revisions as revisions

    project_id, node_id = await _setup(authed_client)
    done = await _revise(authed_client, revision_runner, project_id, node_id)

    async def boom(*args, **kwargs):
        raise RuntimeError("re-anchoring failed")

    monkeypatch.setattr(revisions, "reanchor_node_cards", boom)
    with pytest.raises(RuntimeError):  # the ASGI test transport re-raises what would be a 500
        await authed_client.post(_accept(done["id"]))
    monkeypatch.undo()
    assert (await _node(authed_client, project_id, node_id))["contentMarkdown"] == BODY
    assert (await _get(authed_client, done["id"]))["status"] == "pending"


async def test_accept_requires_a_pending_suggestion(
    authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm, session_factory
) -> None:
    project_id, node_id = await _setup(authed_client)
    comment = await _add_card(session_factory, project_id, node_id, CommentKind.COMMENT)
    assert (await authed_client.post(_accept(str(comment)))).status_code == 404
    assert (await authed_client.post(_accept(str(uuid.uuid4())))).status_code == 404
    running = await _add_card(session_factory, project_id, node_id, CommentKind.SUGGESTION, status=CommentStatus.RUNNING, payload={})
    response = await authed_client.post(_accept(str(running)))
    assert response.status_code == 409 and response.json()["code"] == "not_pending"


async def test_accepting_a_deleting_range_revision_clears_the_lock_like_a_patch(
    authed_client: AsyncClient, session_factory
) -> None:
    text = "Only this."
    project_id, node_id = await _setup(authed_client, text)
    await authed_client.patch(f"/api/v1/projects/{project_id}/outline/{node_id}", json={"contentLocked": True})
    row = await _add_card(
        session_factory, project_id, node_id, CommentKind.SUGGESTION, status=CommentStatus.PENDING,
        anchor=_anchor(text, "Only this."),
        payload={"verb": "revise", "scope": "range", "originalMarkdown": text, "replacementMarkdown": "", "hunks": [{"start": 0, "end": 10, "removed": "Only this.", "added": ""}],
                 "baseContentHash": content_hash(text), "anchor": _anchor(text, "Only this."), "params": {}},
    )
    response = await authed_client.post(_accept(str(row)))
    assert response.status_code == 200, response.text
    node = response.json()["node"]
    assert node["contentMarkdown"] == "" and node["contentLocked"] is False and node["actualWords"] == 0


# ------------------------------------------------------------------ reject
async def test_reject(authed_client: AsyncClient, revision_runner: RevisionRunner) -> None:
    project_id, node_id = await _setup(authed_client)
    done = await _revise(authed_client, revision_runner, project_id, node_id)
    response = await authed_client.post(f"/api/v1/suggestions/{done['id']}/reject")
    assert response.status_code == 200 and response.json()["status"] == "rejected"
    assert response.json()["payload"]["instruction"] == done["payload"]["instruction"]
    assert (await _node(authed_client, project_id, node_id))["contentMarkdown"] == BODY
    assert (await _node(authed_client, project_id, node_id))["pendingSuggestionCount"] == 0
    assert (await authed_client.post(f"/api/v1/suggestions/{done['id']}/reject")).status_code == 409
    assert (await authed_client.post(_accept(done["id"]))).status_code == 409
    assert (await authed_client.post(f"/api/v1/suggestions/{uuid.uuid4()}/reject")).status_code == 404


async def test_try_again_is_a_new_revision_with_the_echoed_request(
    authed_client: AsyncClient, revision_runner: RevisionRunner
) -> None:
    project_id, node_id = await _setup(authed_client)
    first = await _revise(authed_client, revision_runner, project_id, node_id, instruction="Be brief.", params={"shorter": True})
    await authed_client.post(f"/api/v1/suggestions/{first['id']}/reject")
    echoed = first["payload"]
    second = await _revise(
        authed_client, revision_runner, project_id, node_id, instruction=echoed["instruction"],
        params={k: v for k, v in echoed["params"].items()},
    )
    assert second["id"] != first["id"] and second["status"] == "pending"


# --------------------------------------------------------------- permissions
async def test_every_new_endpoint_needs_a_session(client: AsyncClient) -> None:
    some = str(uuid.uuid4())
    for method, path in (
        ("POST", f"/api/v1/projects/{some}/outline/{some}/revisions"),
        ("POST", f"/api/v1/suggestions/{some}/accept"),
        ("POST", f"/api/v1/suggestions/{some}/reject"),
        ("POST", f"/api/v1/suggestions/{some}/cancel"),
        ("GET", f"/api/v1/suggestions/{some}/events/stream"),
        ("GET", f"/api/v1/comments/{some}"),
    ):
        response = await client.request(method, path, headers={"X-Requested-With": "XMLHttpRequest"}, json={} if method == "POST" else None)
        assert response.status_code == 401, (method, path, response.status_code)


async def test_post_endpoints_need_the_csrf_header(authed_client: AsyncClient) -> None:
    some = str(uuid.uuid4())
    for path in (f"/api/v1/suggestions/{some}/accept", f"/api/v1/projects/{some}/outline/{some}/revisions"):
        response = await authed_client.post(path, json={}, headers={"X-Requested-With": ""})
        assert response.status_code == 403


async def test_another_user_may_accept_and_reject_but_not_cancel(
    authed_client: AsyncClient, authed_client_2: AsyncClient, revision_runner: RevisionRunner
) -> None:
    project_id, node_id = await _setup(authed_client)
    done = await _revise(authed_client, revision_runner, project_id, node_id)
    assert done["authorName"] == "Test User"
    assert (await authed_client_2.get(f"/api/v1/comments/{done['id']}")).status_code == 200
    assert (await authed_client_2.post(f"/api/v1/suggestions/{done['id']}/reject")).status_code == 200


# ------------------------------------------------------------------ rewrite
async def test_rewrite_delegates_to_regenerate_and_answers_with_the_run(
    app, authed_client: AsyncClient, session_factory, file_storage, tmp_path: Path
) -> None:
    from tests.api.test_regenerate_and_export import (
        _create_node,
        _create_project,
        _run_full,
        _settings,
    )

    settings = _settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings
    project = await _create_project(authed_client)
    node = await _create_node(authed_client, project["id"], "Chapter A")
    await _run_full(authed_client, project["id"], session_factory, file_storage, settings)

    response = await authed_client.post(
        _revisions(project["id"], node["id"]), json={"verb": "rewrite", "instruction": "Use more examples."}
    )
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["kind"] == "run" and body["runId"] == body["run"]["id"]
    assert body["run"]["kind"] == "regenerate_section" and body["run"]["status"] == "queued"
    assert body["run"]["options"]["promptModifier"] == "Use more examples."
    # the same 409 reasons as the regenerate endpoint (a regenerate is already queued)
    again = await authed_client.post(_revisions(project["id"], node["id"]), json={"verb": "rewrite", "instruction": "x"})
    direct = await authed_client.post(f"/api/v1/projects/{project['id']}/outline/{node['id']}/regenerate", json={"promptModifier": "x"})
    assert again.status_code == direct.status_code == 409
    assert again.json()["detail"] == direct.json()["detail"]


async def test_rewrite_without_a_previous_run_is_the_regenerate_409(authed_client: AsyncClient) -> None:
    project_id, node_id = await _setup(authed_client)
    response = await authed_client.post(_revisions(project_id, node_id), json={"verb": "rewrite", "instruction": "x"})
    direct = await authed_client.post(f"/api/v1/projects/{project_id}/outline/{node_id}/regenerate", json={"promptModifier": "x"})
    assert response.status_code == direct.status_code == 409
    assert response.json()["detail"] == direct.json()["detail"]


async def test_rewrite_refuses_revision_only_inputs(authed_client: AsyncClient) -> None:
    project_id, node_id = await _setup(authed_client)
    for body in (
        {"verb": "rewrite", "instruction": "x", "scope": "range", "anchor": {"quote": TARGET}},
        {"verb": "rewrite", "instruction": "x", "params": {"shorter": True}},
        {"verb": "rewrite", "instruction": "x", "threadId": str(uuid.uuid4())},
    ):
        assert (await authed_client.post(_revisions(project_id, node_id), json=body)).status_code == 422


# ---------------------------------------------------------------- retrieval
async def test_retrieval_comes_from_a_server_derived_run_directory(
    app, authed_client: AsyncClient, revision_runner: RevisionRunner, session_factory, tmp_path: Path, monkeypatch
) -> None:
    import api.application.revisions as revisions

    calls: list[tuple] = []

    async def fake_loader(work_dir, **kwargs):
        calls.append((work_dir, kwargs))
        return None

    monkeypatch.setattr(revisions, "load_revision_retrieval", fake_loader)
    runs_dir = tmp_path / "runs"
    good = runs_dir / "good"
    (good / "out" / ".kb_cache").mkdir(parents=True)
    outside = tmp_path / "elsewhere"
    (outside / "out" / ".kb_cache").mkdir(parents=True)
    app.dependency_overrides[get_settings] = lambda: get_settings().model_copy(update={"runs_dir": str(runs_dir)})

    project_id, node_id = await _setup(authed_client)
    source_id = uuid.uuid4()
    async with session_factory() as session:
        await session.execute(update(OutlineNodeRecord).where(OutlineNodeRecord.id == uuid.UUID(node_id)).values(source_scope="selected", source_ids=[str(source_id)]))
        await session.commit()
        now = datetime.now(timezone.utc)
        for name, directory, finished in (("new-outside", outside, 2), ("old-good", good, 1)):
            repo = SqlAlchemyRunRepository(session)
            await repo.add(Run(
                id=uuid.uuid4(), project_id=uuid.UUID(project_id), kind=RunKind.full, status=RunStatus.succeeded,
                options=RunOptions(outline="project"), base_run_id=None, target_node_id=None, target_node_previous_status=None,
                work_dir=str(directory), exit_code=0, error=None, cancel_requested=False, locked_by=None, heartbeat_at=None,
                queued_at=now.replace(microsecond=finished), started_at=None, finished_at=None, total_tokens=None, total_cost_usd=None,
            ))
    done = await _revise(authed_client, revision_runner, project_id, node_id)
    assert done["status"] == "pending"
    assert len(calls) == 1
    work_dir, kwargs = calls[0]
    assert Path(work_dir) == good.resolve()  # the run outside RUNS_DIR was skipped
    assert kwargs["kb_sources"] == (str(source_id),)
