"""Issue #182 phase 4: the copilot revision service (`api.application.revisions`).

The LLM is the engine's in-process fake (`tests/engine/fake_llm.py`) behind the
runner's `ReviseClientPool(transport=...)` - no network. Projects here never
have a run: revising must work without one.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.application.revisions import RevisionRunner, map_error
from api.core.settings import get_settings
from api.domain.models import CommentKind, CommentStatus, NodeComment
from api.infrastructure.db.comment_repository import SqlAlchemyCommentRepository
from api.infrastructure.db.models import (
    NodeCommentRecord,
    RevisionEventRecord,
    RevisionJobRecord,
)
from api.infrastructure.db.revision_repository import SqlAlchemyRevisionRepository
from engine.errors import (
    AnchorOrphaned,
    InputError,
    ReviseAuthError,
    ReviseConfigError,
    ReviseError,
    ReviseProviderError,
    ReviseRateLimited,
    ReviseTimeout,
    ReviseUnusableOutput,
)
from fake_llm import Fault, FakeLLM

@pytest_asyncio.fixture
async def session_factory(isolated_session_factory):
    """Own connection per session: the revision job runs next to requests."""
    yield isolated_session_factory


PROJECT = {"title": "Quantum codes", "subtitle": "S", "authors": ["Ada"], "topic": "stabilizer codes"}
BODY = (
    "Stabilizer codes protect quantum information.\n\n"
    "The generators of S must pairwise commute, otherwise the group contains minus identity.\n\n"
    "A closing paragraph about syndromes and how errors are detected.\n"
)
TARGET = "The generators of S must pairwise commute"


# ------------------------------------------------------------------- helpers
async def _setup(client: AsyncClient, content: str = BODY) -> tuple[str, str]:
    project_id = (await client.post("/api/v1/projects", json=PROJECT)).json()["id"]
    node_id = (
        await client.post(f"/api/v1/projects/{project_id}/outline", json={"title": "Stabilizers", "summary": "Groups."})
    ).json()["id"]
    if content:
        patched = await client.patch(
            f"/api/v1/projects/{project_id}/outline/{node_id}", json={"contentMarkdown": content}
        )
        assert patched.status_code == 200, patched.text
    return project_id, node_id


def _revisions(project_id: str, node_id: str) -> str:
    return f"/api/v1/projects/{project_id}/outline/{node_id}/revisions"


async def _start(client: AsyncClient, project_id: str, node_id: str, expect: int = 202, **body) -> dict:
    body.setdefault("instruction", "Add a short proof.")
    response = await client.post(_revisions(project_id, node_id), json=body)
    assert response.status_code == expect, response.text
    return response.json()


async def _get(client: AsyncClient, comment_id: str) -> dict:
    response = await client.get(f"/api/v1/comments/{comment_id}")
    assert response.status_code == 200, response.text
    return response.json()


async def _finished(client: AsyncClient, runner: RevisionRunner, comment_id: str) -> dict:
    await runner.wait_idle(20)
    row = await _get(client, comment_id)
    assert row["status"] != "running", row
    return row


async def _revise(client: AsyncClient, runner: RevisionRunner, project_id: str, node_id: str, **body) -> dict:
    started = await _start(client, project_id, node_id, **body)
    return await _finished(client, runner, started["suggestion"]["id"])


async def _node(client: AsyncClient, project_id: str, node_id: str) -> dict:
    return (await client.get(f"/api/v1/projects/{project_id}/outline/{node_id}")).json()


async def _add_card(
    session_factory, project_id: str, node_id: str, kind: CommentKind, *, body="card",
    anchor=None, payload=None, status=CommentStatus.OPEN, thread_of: uuid.UUID | None = None,
) -> uuid.UUID:
    comment_id = uuid.uuid4()
    now = datetime.now(timezone.utc)
    async with session_factory() as session:
        await SqlAlchemyCommentRepository(session).add(
            NodeComment(
                id=comment_id, project_id=uuid.UUID(project_id), node_id=uuid.UUID(node_id), kind=kind,
                author_id=None, anchor=anchor, status=status, thread_id=thread_of or comment_id,
                parent_id=thread_of, body_markdown=body, payload=payload or {}, created_at=now, updated_at=now,
            )
        )
    return comment_id


def _anchor(text: str, quote: str) -> dict:
    start = text.index(quote)
    return {"quote": quote, "prefix": text[max(0, start - 32) : start], "suffix": text[start + len(quote) : start + len(quote) + 32], "start": start, "end": start + len(quote)}


# -------------------------------------------------------------- happy paths
async def test_section_revision_on_a_project_without_runs(
    authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM
) -> None:
    project_id, node_id = await _setup(authed_client)
    started = await _start(authed_client, project_id, node_id, params={"moreExamples": True})
    assert started["kind"] == "suggestion"
    card = started["suggestion"]
    assert card["kind"] == "suggestion" and card["status"] == "running"
    assert card["anchor"] is None and card["threadId"] == card["id"] and card["parentId"] is None
    assert card["authorName"] and card["payload"]["verb"] == "revise" and card["payload"]["scope"] == "section"
    assert card["payload"]["instruction"] == "Add a short proof."
    assert card["payload"]["params"]["moreExamples"] is True

    # the badge counts it while it runs
    assert (await _node(authed_client, project_id, node_id))["pendingSuggestionCount"] == 1

    done = await _finished(authed_client, revision_runner, card["id"])
    assert done["status"] == "pending"
    payload = done["payload"]
    assert payload["originalMarkdown"] == BODY
    assert payload["replacementMarkdown"].startswith(BODY.rstrip()) and "(revised)" in payload["replacementMarkdown"]
    assert payload["hunks"] and all({"start", "end", "removed", "added"} <= set(h) for h in payload["hunks"])
    assert payload["summary"] == "Revised section." and payload["changesMade"] == ["added an example"]
    assert payload["model"] and payload["usage"] and payload["baseContentHash"]
    assert payload["startedAt"] and payload["finishedAt"] and payload["warnings"] == [] and payload["droppedCitations"] == []
    assert payload["instruction"] == "Add a short proof." and payload["params"]["moreExamples"] is True
    assert done["bodyMarkdown"] == "Revised section."
    # the model call carried the options of the node, no key leaked into the payload
    prompt = fake_llm.chat_calls("SectionRevision")[0].prompt
    assert "Add a short proof." in prompt and "Quantum codes" in prompt and "Stabilizers" in prompt
    assert "sk-deployment-test-key" not in json.dumps(done)
    assert (await _node(authed_client, project_id, node_id))["pendingSuggestionCount"] == 1  # pending counts too
    # the node itself is untouched
    assert (await _node(authed_client, project_id, node_id))["contentMarkdown"] == BODY


async def test_range_revision_only_changes_the_selected_range(
    authed_client: AsyncClient, revision_runner: RevisionRunner
) -> None:
    project_id, node_id = await _setup(authed_client)
    done = await _revise(
        authed_client, revision_runner, project_id, node_id,
        scope="range", anchor={"quote": TARGET, "start": BODY.index(TARGET), "end": BODY.index(TARGET) + len(TARGET)},
    )
    assert done["status"] == "pending"
    assert done["anchor"]["quote"] == TARGET and done["anchor"]["start"] == BODY.index(TARGET)
    payload = done["payload"]
    assert payload["scope"] == "range" and payload["anchor"]["start"] == BODY.index(TARGET)
    new = payload["replacementMarkdown"]
    start = BODY.index(TARGET)
    assert new[:start] == BODY[:start] and new.endswith(BODY[start + len(TARGET):])
    assert "An added proof sentence (revised)." in new
    assert all(start <= h["start"] and h["end"] <= start + len(TARGET) for h in payload["hunks"])


async def test_revision_inside_a_comment_thread_inherits_its_anchor_and_passes_the_thread(
    authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM
) -> None:
    project_id, node_id = await _setup(authed_client)
    root = (await authed_client.post(
        f"/api/v1/projects/{project_id}/outline/{node_id}/comments",
        json={"bodyMarkdown": "This sentence needs a justification.", "anchor": {"quote": TARGET}},
    )).json()
    await authed_client.post(
        f"/api/v1/projects/{project_id}/outline/{node_id}/comments",
        json={"bodyMarkdown": "Agreed, please add the reason.", "parentId": root["id"]},
    )
    started = await _start(authed_client, project_id, node_id, scope="range", threadId=root["id"], instruction="")
    card = started["suggestion"]
    assert card["threadId"] == root["id"] and card["parentId"] == root["id"]
    assert card["anchor"]["quote"] == TARGET
    done = await _finished(authed_client, revision_runner, card["id"])
    assert done["status"] == "pending" and done["payload"]["threadId"] == root["id"]
    prompt = fake_llm.chat_calls("RangeRevision")[0].prompt
    assert "needs a justification" in prompt and "please add the reason" in prompt
    # the thread lists the suggestion among its rows
    listed = (await authed_client.get(f"/api/v1/projects/{project_id}/outline/{node_id}/comments")).json()["items"]
    assert [c["kind"] for c in listed] == ["comment", "comment", "suggestion"]


async def test_fix_issue_ids_pass_the_stored_review_issues(
    authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    project_id, node_id = await _setup(authed_client)
    review = await _add_card(
        session_factory, project_id, node_id, CommentKind.REVIEW, body="The claim has no justification.",
        anchor=_anchor(BODY, TARGET),
        payload={"type": "coverage", "severity": "major", "requiredFix": "Justify it.", "replaceFrom": "", "replaceTo": ""},
    )
    done = await _revise(authed_client, revision_runner, project_id, node_id, instruction="", params={"fixIssueIds": [str(review)]})
    assert done["status"] == "pending" and done["payload"]["params"]["fixIssueIds"] == [str(review)]
    prompt = fake_llm.chat_calls("SectionRevision")[0].prompt
    assert "The claim has no justification." in prompt and "Justify it." in prompt and TARGET in prompt


async def test_brief_and_validation_edges(authed_client: AsyncClient, session_factory) -> None:
    project_id, node_id = await _setup(authed_client)
    other_project, other_node = await _setup(authed_client)
    foreign = await _add_card(session_factory, other_project, other_node, CommentKind.REVIEW, payload={"type": "x"})
    comment = await _add_card(session_factory, project_id, node_id, CommentKind.COMMENT)

    async def bad(expect: int, **body) -> dict:
        response = await authed_client.post(_revisions(project_id, node_id), json=body)
        assert response.status_code == expect, response.text
        return response.json()

    await bad(422, instruction="x", params={"shorter": True, "longer": True})
    await bad(422)  # nothing to do
    await bad(422, instruction="x" * 4001)
    await bad(422, instruction="x", params={"fixIssueIds": [str(foreign)]})
    await bad(422, instruction="x", params={"fixIssueIds": [str(comment)]})  # a comment is not an issue
    await bad(422, instruction="x", params={"addressCommentIds": [str(uuid.uuid4())]})
    await bad(422, instruction="x", scope="range")  # no anchor
    await bad(422, instruction="x", anchor={"quote": TARGET})  # anchor needs scope range
    await bad(422, instruction="x", threadId=str(foreign))
    await bad(422, instruction="x", frobnicate=1)
    problem = await bad(409, instruction="x", scope="range", anchor={"quote": "text that is not in the section"})
    assert problem["code"] == "anchor_orphaned"
    empty_project, empty_node = await _setup(authed_client, content="")
    response = await authed_client.post(_revisions(empty_project, empty_node), json={"instruction": "x"})
    assert response.status_code == 409 and response.json()["code"] == "section_empty"
    assert (await authed_client.post(_revisions(project_id, str(uuid.uuid4())), json={"instruction": "x"})).status_code == 404
    assert (await authed_client.post(_revisions(str(uuid.uuid4()), node_id), json={"instruction": "x"})).status_code == 404
    # nothing was created by any of the above
    assert (await authed_client.get(f"/api/v1/projects/{project_id}/outline/{node_id}/comments?kind=suggestion")).json()["total"] == 0


async def test_a_generating_node_cannot_be_revised(authed_client: AsyncClient) -> None:
    project_id, node_id = await _setup(authed_client)
    await authed_client.patch(f"/api/v1/projects/{project_id}/outline/{node_id}", json={"status": "drafting"})
    response = await authed_client.post(_revisions(project_id, node_id), json={"instruction": "x"})
    assert response.status_code == 409 and response.json()["code"] == "node_generating"


# ---------------------------------------------------------- list trimming
async def test_project_list_trims_heavy_payload_keys_but_node_list_and_get_keep_them(
    authed_client: AsyncClient, revision_runner: RevisionRunner
) -> None:
    project_id, node_id = await _setup(authed_client)
    done = await _revise(authed_client, revision_runner, project_id, node_id)
    in_project = (await authed_client.get(f"/api/v1/projects/{project_id}/comments")).json()["items"]
    assert [c["id"] for c in in_project] == [done["id"]]
    assert "originalMarkdown" not in in_project[0]["payload"] and "replacementMarkdown" not in in_project[0]["payload"]
    assert in_project[0]["payload"]["hunks"] and in_project[0]["payload"]["summary"]
    in_node = (await authed_client.get(f"/api/v1/projects/{project_id}/outline/{node_id}/comments")).json()["items"]
    assert in_node[0]["payload"]["originalMarkdown"] == BODY and in_node[0]["payload"]["replacementMarkdown"]
    assert (await _get(authed_client, done["id"]))["payload"]["replacementMarkdown"]


# ----------------------------------------------------------- failure mapping
@pytest.mark.parametrize(
    ("exc", "code"),
    [
        (AnchorOrphaned("x"), "anchor_orphaned"),
        (ReviseConfigError("no key"), "llm_config"),
        (ReviseAuthError("sk-secret rejected"), "llm_auth"),
        (ReviseRateLimited("slow down"), "llm_rate_limited"),
        (ReviseTimeout("slow"), "llm_timeout"),
        (ReviseUnusableOutput("bad json"), "unusable_output"),
        (ReviseProviderError("boom https://x.example/v1 key=sk-abc"), "llm_error"),
        (ReviseError("the model echoed the section context"), "revision_failed"),
        (InputError("nothing to do"), "invalid_request"),
        (asyncio.TimeoutError(), "timeout"),
        (RuntimeError("secret /app/runs/x/y"), "internal"),
    ],
)
def test_error_mapping(exc: BaseException, code: str) -> None:
    exc_usage = {"total_tokens": 7}
    if isinstance(exc, ReviseError):
        exc.usage = exc_usage
    mapped, message, usage = map_error(exc)
    assert mapped == code
    assert "sk-" not in message and "https://" not in message and "/app/runs" not in message
    assert usage == (exc_usage if isinstance(exc, ReviseError) else {})


async def _failed_with(client, runner, project_id, node_id) -> dict:
    row = await _revise(client, runner, project_id, node_id)
    assert row["status"] == "failed", row
    assert row["payload"]["instruction"] == "Add a short proof."  # the request echo survives for "try again"
    assert row["payload"]["finishedAt"] and "replacementMarkdown" not in row["payload"]
    return row


async def test_provider_auth_failure_is_mapped_and_hides_the_provider_text(
    authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM
) -> None:
    fake_llm.faults.append(Fault(status=401, times=None, message="Incorrect API key provided: sk-depl...-key"))
    project_id, node_id = await _setup(authed_client)
    row = await _failed_with(authed_client, revision_runner, project_id, node_id)
    assert row["payload"]["error"]["code"] == "llm_auth"
    assert "sk-" not in json.dumps(row)


async def test_rate_limit_and_unusable_output_are_mapped(
    authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM
) -> None:
    project_id, node_id = await _setup(authed_client)
    fake_llm.faults.append(Fault(status=429, times=None, retry_after=0))
    row = await _failed_with(authed_client, revision_runner, project_id, node_id)
    assert row["payload"]["error"]["code"] == "llm_rate_limited"

    fake_llm.faults.clear()
    fake_llm.overrides["SectionRevision"] = lambda call: {"unexpected": 1}
    row = await _failed_with(authed_client, revision_runner, project_id, node_id)
    assert row["payload"]["error"]["code"] == "unusable_output"
    assert row["payload"]["usage"]  # the spend is kept on a failure


async def test_server_error_is_a_provider_failure(
    authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM
) -> None:
    fake_llm.faults.append(Fault(status=500, times=None))
    project_id, node_id = await _setup(authed_client)
    row = await _failed_with(authed_client, revision_runner, project_id, node_id)
    assert row["payload"]["error"]["code"] == "llm_error"


async def test_overall_timeout_fails_the_job(
    app, authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM
) -> None:
    app.dependency_overrides[get_settings] = lambda: get_settings().model_copy(update={"revision_timeout_s": 0.4})
    revision_runner._settings = get_settings().model_copy(update={"revision_timeout_s": 0.4})
    fake_llm.latency_s = 3.0
    project_id, node_id = await _setup(authed_client)
    row = await _failed_with(authed_client, revision_runner, project_id, node_id)
    assert row["payload"]["error"]["code"] == "timeout"


async def test_no_llm_key_configured_is_a_clear_409(
    authed_client: AsyncClient, revision_runner: RevisionRunner
) -> None:
    revision_runner._env = {"AUTOGENBOOK_LLM_BASE_URL": "https://openrouter.ai/api/v1"}
    project_id, node_id = await _setup(authed_client)
    response = await authed_client.post(_revisions(project_id, node_id), json={"instruction": "x"})
    assert response.status_code == 409 and response.json()["code"] == "llm_not_configured"


# ----------------------------------------------------------- cancel / caps
async def test_cancel_a_running_revision(
    authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM
) -> None:
    fake_llm.latency_s = 5.0
    project_id, node_id = await _setup(authed_client)
    card = (await _start(authed_client, project_id, node_id))["suggestion"]
    await asyncio.sleep(0.3)
    assert revision_runner.owns(uuid.UUID(card["id"]))
    response = await authed_client.post(f"/api/v1/suggestions/{card['id']}/cancel")
    assert response.status_code == 200 and response.json()["status"] == "cancelled"
    await revision_runner.wait_idle(5)
    assert revision_runner.running_jobs == 0
    final = await _get(authed_client, card["id"])
    assert final["status"] == "cancelled" and final["payload"]["finishedAt"]
    assert final["payload"]["instruction"] == "Add a short proof."
    # idempotent; and a finished revision cannot be cancelled
    assert (await authed_client.post(f"/api/v1/suggestions/{card['id']}/cancel")).json()["status"] == "cancelled"
    assert (await _node(authed_client, project_id, node_id))["pendingSuggestionCount"] == 0


async def test_cancel_from_another_replica_stops_the_owner(
    authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A replica that does not own the task only flips the row (a compare-and-set);
    the owner polls it and stops."""
    fake_llm.latency_s = 5.0
    project_id, node_id = await _setup(authed_client)
    card = (await _start(authed_client, project_id, node_id))["suggestion"]
    await asyncio.sleep(0.3)
    async with session_factory() as session:
        ok = await SqlAlchemyCommentRepository(session).transition_suggestion(
            uuid.UUID(card["id"]), CommentStatus.RUNNING, status=CommentStatus.CANCELLED, payload={**card["payload"], "cancelledBy": "other"},
        )
        assert ok
    await revision_runner.wait_idle(5)
    assert revision_runner.running_jobs == 0
    assert (await _get(authed_client, card["id"]))["status"] == "cancelled"


async def test_only_the_author_cancels(
    authed_client: AsyncClient, authed_client_2: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM
) -> None:
    fake_llm.latency_s = 5.0
    project_id, node_id = await _setup(authed_client)
    card = (await _start(authed_client, project_id, node_id))["suggestion"]
    assert (await authed_client_2.post(f"/api/v1/suggestions/{card['id']}/cancel")).status_code == 403
    assert (await authed_client.post(f"/api/v1/suggestions/{card['id']}/cancel")).status_code == 200


async def test_one_running_revision_per_node(
    authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM
) -> None:
    fake_llm.latency_s = 5.0
    project_id, node_id = await _setup(authed_client)
    first = (await _start(authed_client, project_id, node_id))["suggestion"]
    response = await authed_client.post(_revisions(project_id, node_id), json={"instruction": "again"})
    assert response.status_code == 409 and response.json()["code"] == "revision_in_progress"
    await authed_client.post(f"/api/v1/suggestions/{first['id']}/cancel")
    # once cancelled a new one may start
    await _start(authed_client, project_id, node_id)


async def test_the_database_arbitrates_simultaneous_starts(
    authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM
) -> None:
    fake_llm.latency_s = 2.0
    project_id, node_id = await _setup(authed_client)
    results = await asyncio.gather(
        *(authed_client.post(_revisions(project_id, node_id), json={"instruction": f"go {i}"}) for i in range(3))
    )
    assert sorted(r.status_code for r in results).count(202) == 1
    assert {r.status_code for r in results} <= {202, 409}


async def test_per_user_cap(
    app, authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM
) -> None:
    app.dependency_overrides[get_settings] = lambda: get_settings().model_copy(update={"revision_max_per_user": 2})
    fake_llm.latency_s = 5.0
    ids = [await _setup(authed_client) for _ in range(3)]
    await _start(authed_client, *ids[0])
    await _start(authed_client, *ids[1])
    response = await authed_client.post(_revisions(*ids[2]), json={"instruction": "x"})
    assert response.status_code == 429 and response.json()["code"] == "too_many_revisions"


# ------------------------------------------------------------- crash recovery
async def test_stale_running_revisions_are_failed_as_interrupted(
    authed_client: AsyncClient, revision_runner: RevisionRunner, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    project_id, node_id = await _setup(authed_client)
    stale = await _add_card(session_factory, project_id, node_id, CommentKind.SUGGESTION, status=CommentStatus.RUNNING, payload={"instruction": "x", "verb": "revise"})
    async with session_factory() as session:
        await SqlAlchemyRevisionRepository(session).add_job(stale, "otherhost:abc", datetime.now(timezone.utc) - timedelta(seconds=600))
        await session.commit()
    # a live job on another replica (fresh heartbeat) is left alone
    other_project, other_node = await _setup(authed_client)
    alive = await _add_card(session_factory, other_project, other_node, CommentKind.SUGGESTION, status=CommentStatus.RUNNING, payload={"verb": "revise"})
    async with session_factory() as session:
        await SqlAlchemyRevisionRepository(session).add_job(alive, "otherhost:def", datetime.now(timezone.utc))
        await session.commit()

    await revision_runner.start()
    row = await _get(authed_client, str(stale))
    assert row["status"] == "failed" and row["payload"]["error"]["code"] == "interrupted"
    assert row["payload"]["instruction"] == "x"
    assert (await _get(authed_client, str(alive)))["status"] == "running"


async def test_startup_fails_jobs_of_an_earlier_process_of_the_same_host_at_once(
    authed_client: AsyncClient, revision_runner: RevisionRunner, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    project_id, node_id = await _setup(authed_client)
    orphan = await _add_card(session_factory, project_id, node_id, CommentKind.SUGGESTION, status=CommentStatus.RUNNING, payload={"verb": "revise"})
    async with session_factory() as session:
        await SqlAlchemyRevisionRepository(session).add_job(orphan, "testhost:previous-process", datetime.now(timezone.utc))
        await session.commit()
    await revision_runner.start()
    assert (await _get(authed_client, str(orphan)))["payload"]["error"]["code"] == "interrupted"


async def test_lifespan_closes_the_runner_and_fails_running_jobs(
    app, authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM
) -> None:
    fake_llm.latency_s = 5.0
    project_id, node_id = await _setup(authed_client)
    card = (await _start(authed_client, project_id, node_id))["suggestion"]
    await asyncio.sleep(0.2)
    await revision_runner.aclose()
    assert revision_runner.running_jobs == 0 and revision_runner._pool is None
    row = await _get(authed_client, card["id"])
    assert row["status"] == "failed" and row["payload"]["error"]["code"] == "interrupted"


# ------------------------------------------------------------------- events
async def _stream(client: AsyncClient, comment_id: str, headers: dict | None = None) -> list[tuple[str, str, dict]]:
    events: list[tuple[str, str, dict]] = []
    name = ident = ""
    async with client.stream("GET", f"/api/v1/suggestions/{comment_id}/events/stream", headers=headers or {}) as response:
        assert response.status_code == 200
        async for line in response.aiter_lines():
            if line.startswith("event:"):
                name = line.removeprefix("event:").strip()
            elif line.startswith("id:"):
                ident = line.removeprefix("id:").strip()
            elif line.startswith("data:"):
                events.append((name, ident, json.loads(line.removeprefix("data:").strip())))
    return events


async def test_sse_stream_progress_then_terminal_done_and_resume(
    authed_client: AsyncClient, revision_runner: RevisionRunner
) -> None:
    project_id, node_id = await _setup(authed_client)
    card = (await _start(authed_client, project_id, node_id))["suggestion"]
    events = await _stream(authed_client, card["id"])
    names = [e[0] for e in events]
    assert names[-1] == "done" and set(names[:-1]) == {"progress"} and len(names) >= 4
    progress = [e[2] for e in events[:-1]]
    assert [p["seq"] for p in progress] == list(range(1, len(progress) + 1))
    assert {p["stage"] for p in progress} >= {"revise", "diff"}
    assert all({"ts", "level", "message"} <= set(p) for p in progress)
    terminal = events[-1][2]
    assert terminal["status"] == "pending" and terminal["suggestion"]["id"] == card["id"]
    assert terminal["suggestion"]["payload"]["replacementMarkdown"]

    # a reconnect resumes after the last seen id; a finished job ends right away
    again = await _stream(authed_client, card["id"], {"Last-Event-ID": events[1][1]})
    assert [e[1] for e in again if e[0] == "progress"] == [e[1] for e in events[2:-1]]
    assert again[-1][0] == "done"
    final_only = await _stream(authed_client, card["id"], {"Last-Event-ID": str(len(progress))})
    assert [e[0] for e in final_only] == ["done"]


async def test_sse_stream_ends_with_failed_and_cancelled(
    authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM
) -> None:
    project_id, node_id = await _setup(authed_client)
    fake_llm.faults.append(Fault(status=401, times=None))
    card = (await _start(authed_client, project_id, node_id))["suggestion"]
    events = await _stream(authed_client, card["id"])
    assert events[-1][0] == "failed" and events[-1][2]["suggestion"]["payload"]["error"]["code"] == "llm_auth"

    fake_llm.faults.clear()
    fake_llm.latency_s = 5.0
    # the pool shares an endpoint-wide failure of the structured-output probe
    # for a few seconds (engine behaviour): start from a fresh pool
    await revision_runner.pool.aclose()
    revision_runner._pool = None
    card = (await _start(authed_client, project_id, node_id))["suggestion"]
    stream = asyncio.create_task(_stream(authed_client, card["id"]))
    await asyncio.sleep(0.4)
    await authed_client.post(f"/api/v1/suggestions/{card['id']}/cancel")
    events = await asyncio.wait_for(stream, 10)
    assert events[-1][0] == "cancelled" and events[-1][2]["status"] == "cancelled"


async def test_sse_stream_404_for_unknown_and_non_suggestions(authed_client: AsyncClient, session_factory) -> None:
    project_id, node_id = await _setup(authed_client)
    comment = await _add_card(session_factory, project_id, node_id, CommentKind.COMMENT)
    assert (await authed_client.get(f"/api/v1/suggestions/{uuid.uuid4()}/events/stream")).status_code == 404
    assert (await authed_client.get(f"/api/v1/suggestions/{comment}/events/stream")).status_code == 404


async def test_events_are_persisted_for_reconnecting_clients(
    authed_client: AsyncClient, revision_runner: RevisionRunner, session_factory
) -> None:
    project_id, node_id = await _setup(authed_client)
    card = await _revise(authed_client, revision_runner, project_id, node_id)
    async with session_factory() as session:
        rows = (await session.execute(select(RevisionEventRecord).where(RevisionEventRecord.comment_id == uuid.UUID(card["id"])))).scalars().all()
        jobs = (await session.execute(select(RevisionJobRecord))).scalars().all()
    assert len(rows) >= 3 and {r.stage for r in rows} >= {"revise", "diff"}
    assert [j.owner for j in jobs] == [revision_runner.instance_id]


# ---------------------------------------------------------------- user keys
async def test_users_own_key_is_used_and_the_policy_can_require_it(
    app, authed_client: AsyncClient, revision_runner: RevisionRunner, seeded_user, session_factory
) -> None:
    from cryptography.fernet import Fernet

    from api.core.secrets import LlmKeyCipher
    from api.infrastructure.db.models import UserRecord

    fernet_key = Fernet.generate_key().decode()
    settings = get_settings().model_copy(update={"llm_key_encryption_key": fernet_key, "llm_key_policy": "required"})
    app.dependency_overrides[get_settings] = lambda: settings
    project_id, node_id = await _setup(authed_client)
    response = await authed_client.post(_revisions(project_id, node_id), json={"instruction": "x"})
    assert response.status_code == 409 and response.json()["code"] == "llm_key_required"

    async with session_factory() as session:
        await session.execute(
            update(UserRecord).where(UserRecord.id == seeded_user.id).values(
                llm_api_key_encrypted=LlmKeyCipher(fernet_key).encrypt("sk-user-own-key"), llm_api_key_last4="-key"
            )
        )
        await session.commit()
    card = await _revise(authed_client, revision_runner, project_id, node_id)
    assert card["status"] == "pending"
    keys = [k[1] for k in revision_runner.pool._clients]
    assert keys == ["sk-user-own-key"]  # the deployment key was not used
    assert "sk-user-own-key" not in json.dumps(card)


async def test_deleting_a_running_suggestion_stops_its_job(
    authed_client: AsyncClient, revision_runner: RevisionRunner, fake_llm: FakeLLM
) -> None:
    fake_llm.latency_s = 5.0
    project_id, node_id = await _setup(authed_client)
    card = (await _start(authed_client, project_id, node_id))["suggestion"]
    await asyncio.sleep(0.3)
    assert (await authed_client.delete(f"/api/v1/comments/{card['id']}")).status_code == 204
    await revision_runner.wait_idle(5)
    assert revision_runner.running_jobs == 0
    assert (await authed_client.get(f"/api/v1/comments/{card['id']}")).status_code == 404
    assert (await _node(authed_client, project_id, node_id))["pendingSuggestionCount"] == 0
    await _start(authed_client, project_id, node_id)  # the node is free again


async def test_get_comment_404(authed_client: AsyncClient) -> None:
    assert (await authed_client.get(f"/api/v1/comments/{uuid.uuid4()}")).status_code == 404
