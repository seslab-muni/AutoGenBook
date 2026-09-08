from __future__ import annotations

import dataclasses
import uuid
from datetime import datetime, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.core.errors import NotFound
from api.domain.models import RunStatus
from api.infrastructure.db.models import RunRecord
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


async def _create_run(client: AsyncClient, project_id: str, **overrides) -> dict:
    response = await client.post(f"/api/v1/projects/{project_id}/runs", json=overrides)
    assert response.status_code == 202, response.text
    return response.json()


async def test_create_run_applies_defaults_from_project(client: AsyncClient) -> None:
    project = await _create_project(client, outputFormat="latex")

    body = await _create_run(client, project["id"])

    assert uuid.UUID(body["id"])
    assert body["projectId"] == project["id"]
    assert body["kind"] == "full"
    assert body["status"] == "queued"
    assert body["options"]["outline"] == "project"
    assert body["options"]["outputFormat"] == "latex"
    assert body["options"]["allowSubdivision"] is False
    assert body["options"]["auditBookMode"] == "warn"
    assert body["exitCode"] is None
    assert body["totalTokens"] is None
    assert body["queuedAt"]


async def test_create_run_accepts_explicit_options(client: AsyncClient) -> None:
    project = await _create_project(client)

    body = await _create_run(
        client,
        project["id"],
        outline="generate",
        outputFormat="pdf",
        allowSubdivision=True,
        enableWebRag=True,
        auditBook=True,
        auditBookMode="strict",
    )

    assert body["options"]["outline"] == "generate"
    assert body["options"]["outputFormat"] == "pdf"
    assert body["options"]["allowSubdivision"] is True
    assert body["options"]["enableWebRag"] is True
    assert body["options"]["auditBook"] is True
    assert body["options"]["auditBookMode"] == "strict"


async def test_create_run_does_not_set_project_last_run_id_before_it_succeeds(
    client: AsyncClient,
) -> None:
    """issue #66: `lastRunId` is only ever advanced by the worker once a run
    actually succeeds (`GenerationService._import_graph`/
    `_import_target_node`) - queueing one must not overwrite it eagerly, or
    a later failed/cancelled/still-queued run would permanently point
    `lastRunId` at something regenerate/export can't resume from."""
    project = await _create_project(client)
    await _create_run(client, project["id"])

    response = await client.get(f"/api/v1/projects/{project['id']}")
    assert response.status_code == 200
    assert response.json()["lastRunId"] is None


async def test_create_run_404_for_missing_project(client: AsyncClient) -> None:
    response = await client.post(f"/api/v1/projects/{uuid.uuid4()}/runs", json={})
    assert response.status_code == 404


async def test_create_run_409_when_project_already_has_active_run(client: AsyncClient) -> None:
    project = await _create_project(client)
    await _create_run(client, project["id"])

    response = await client.post(f"/api/v1/projects/{project['id']}/runs", json={})
    assert response.status_code == 409


async def test_create_run_rejects_legacy_tex_with_markdown_output(client: AsyncClient) -> None:
    # `legacyTex` + `outputFormat: "markdown"` used to "succeed" with no
    # document at all: `content_format="latex"` disables the Markdown
    # assembly path, and no `tex`/`pdf` output was requested either
    # (issue #79).
    project = await _create_project(client, outputFormat="markdown")

    response = await client.post(
        f"/api/v1/projects/{project['id']}/runs",
        json={"legacyTex": True, "outputFormat": "markdown"},
    )
    assert response.status_code == 422, response.text

    list_response = await client.get(f"/api/v1/projects/{project['id']}/runs")
    assert list_response.json()["total"] == 0


async def test_create_run_rejects_legacy_tex_defaulting_to_project_markdown_format(
    client: AsyncClient,
) -> None:
    project = await _create_project(client, outputFormat="markdown")

    response = await client.post(
        f"/api/v1/projects/{project['id']}/runs", json={"legacyTex": True}
    )
    assert response.status_code == 422, response.text


async def test_create_run_rejects_audit_book_with_markdown_output(client: AsyncClient) -> None:
    # `auditBook` needs a `tex_path` the markdown assembly path never
    # produces - the option used to be silently ignored (issue #79).
    project = await _create_project(client, outputFormat="markdown")

    response = await client.post(
        f"/api/v1/projects/{project['id']}/runs",
        json={"auditBook": True, "outputFormat": "markdown"},
    )
    assert response.status_code == 422, response.text


async def test_create_run_allows_legacy_tex_and_audit_book_with_latex_output(
    client: AsyncClient,
) -> None:
    project = await _create_project(client, outputFormat="markdown")

    response = await client.post(
        f"/api/v1/projects/{project['id']}/runs",
        json={"legacyTex": True, "auditBook": True, "outputFormat": "latex"},
    )
    assert response.status_code == 202, response.text


async def test_get_run(client: AsyncClient) -> None:
    project = await _create_project(client)
    created = await _create_run(client, project["id"])

    response = await client.get(f"/api/v1/runs/{created['id']}")
    assert response.status_code == 200
    assert response.json()["id"] == created["id"]


async def test_get_run_404(client: AsyncClient) -> None:
    response = await client.get(f"/api/v1/runs/{uuid.uuid4()}")
    assert response.status_code == 404


async def test_list_runs_for_project(client: AsyncClient) -> None:
    project = await _create_project(client)
    created = await _create_run(client, project["id"])

    response = await client.get(f"/api/v1/projects/{project['id']}/runs")
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert body["items"][0]["id"] == created["id"]


async def test_cancel_queued_run_is_immediately_cancelled(client: AsyncClient) -> None:
    project = await _create_project(client)
    created = await _create_run(client, project["id"])

    response = await client.post(f"/api/v1/runs/{created['id']}/cancel")
    assert response.status_code == 202
    body = response.json()
    assert body["status"] == "cancelled"


async def test_cancel_already_terminal_run_is_409(client: AsyncClient) -> None:
    project = await _create_project(client)
    created = await _create_run(client, project["id"])
    await client.post(f"/api/v1/runs/{created['id']}/cancel")

    response = await client.post(f"/api/v1/runs/{created['id']}/cancel")
    assert response.status_code == 409


async def test_run_to_schema_stats_the_work_dir_off_the_event_loop(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession], monkeypatch
) -> None:
    """Regression for issue #55: `run_to_schema`'s `resumable` field did a
    plain `Path(run.work_dir).is_dir()` - a blocking `stat(2)` against the
    shared `runs_data` volume, issued directly on the request coroutine for
    every run in a list response. It should now go through
    `run_in_threadpool`."""
    import threading

    from api.presentation.schemas import runs as runs_schema_module

    project = await _create_project(client)
    await _create_run(client, project["id"])

    main_thread = threading.current_thread()
    stat_threads: list[threading.Thread] = []
    original_is_dir = runs_schema_module.Path.is_dir

    def spy_is_dir(self):
        stat_threads.append(threading.current_thread())
        return original_is_dir(self)

    monkeypatch.setattr(runs_schema_module.Path, "is_dir", spy_is_dir)

    response = await client.get(f"/api/v1/projects/{project['id']}/runs")

    assert response.status_code == 200
    assert stat_threads, "expected run_to_schema to check work_dir.is_dir()"
    assert all(t is not main_thread for t in stat_threads)


async def test_cancel_does_not_revert_a_run_the_worker_just_finished(
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression for issue #56: `POST /runs/{id}/cancel` on a `running` run
    used to read the row, then blindly write back its own stale copy of
    *every* column (`status=running, exitCode=None, finishedAt=None, ...`
    plus `cancelRequested=True`). If the worker's own `_finalize` committed
    `succeeded` in the narrow window between that read and this write,
    cancel's overwrite reverted the run back to `running` with no worker
    attached - it would then sit until `requeue_stale` handed it to a new
    worker, which re-executed it (a `full` run from scratch) even though it
    had already finished successfully.

    Simulates that exact interleaving via `SqlAlchemyRunRepository.
    request_cancel` (the method `RunService.cancel`'s write now goes
    through): before its real conditional `UPDATE` runs, a concurrent
    session commits the run as `succeeded` - exactly as if the worker's own
    `_finalize` landed in that window.
    """
    project = await _create_project(client)
    created = await _create_run(client, project["id"])
    run_id = uuid.UUID(created["id"])

    async with session_factory() as session:
        repo = SqlAlchemyRunRepository(session)
        current = await repo.get(run_id)
        assert current is not None
        await repo.update(
            dataclasses.replace(
                current,
                status=RunStatus.running,
                locked_by="worker-1",
                started_at=datetime.now(timezone.utc),
                heartbeat_at=datetime.now(timezone.utc),
            )
        )

    original_request_cancel = SqlAlchemyRunRepository.request_cancel

    async def _request_cancel_after_worker_finishes(self, requested_run_id):
        async with session_factory() as finisher_session:
            finisher_repo = SqlAlchemyRunRepository(finisher_session)
            finishing = await finisher_repo.get(requested_run_id)
            assert finishing is not None
            finalized = await finisher_repo.finalize(
                dataclasses.replace(
                    finishing,
                    status=RunStatus.succeeded,
                    exit_code=0,
                    error=None,
                    finished_at=datetime.now(timezone.utc),
                    total_tokens=42,
                )
            )
            assert finalized is not None
        return await original_request_cancel(self, requested_run_id)

    monkeypatch.setattr(
        SqlAlchemyRunRepository, "request_cancel", _request_cancel_after_worker_finishes
    )

    response = await client.post(f"/api/v1/runs/{run_id}/cancel")

    async with session_factory() as session:
        final = await SqlAlchemyRunRepository(session).get(run_id)

    assert response.status_code == 202
    assert final is not None
    # The worker's own "succeeded" must win - cancel must not have reverted
    # it back to `running`/`cancelled` or clobbered `exitCode`/`finishedAt`.
    assert final.status == RunStatus.succeeded
    assert final.exit_code == 0
    assert final.finished_at is not None
    assert final.total_tokens == 42


async def test_cancel_run_404(client: AsyncClient) -> None:
    response = await client.post(f"/api/v1/runs/{uuid.uuid4()}/cancel")
    assert response.status_code == 404


async def test_cancel_queued_run_persists_a_done_event(client: AsyncClient) -> None:
    """issue #63: the worker's own `_finalize`/`_fail` (and its `_emit_done`)
    never run for a run cancelled while still `queued` - without this,
    `GET /runs/{id}/events` stayed empty forever and `.../events/stream`
    would poll forever waiting for a "done" event that was never coming."""
    project = await _create_project(client)
    created = await _create_run(client, project["id"])

    await client.post(f"/api/v1/runs/{created['id']}/cancel")

    response = await client.get(f"/api/v1/runs/{created['id']}/events")
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert body["items"][0]["stage"] == "done"
    assert body["items"][0]["payload"]["status"] == "cancelled"


async def test_list_run_events_empty_for_freshly_created_run(client: AsyncClient) -> None:
    project = await _create_project(client)
    created = await _create_run(client, project["id"])

    response = await client.get(f"/api/v1/runs/{created['id']}/events")
    assert response.status_code == 200
    body = response.json()
    assert body["items"] == []
    assert body["total"] == 0


async def test_list_run_events_404_for_missing_run(client: AsyncClient) -> None:
    response = await client.get(f"/api/v1/runs/{uuid.uuid4()}/events")
    assert response.status_code == 404


async def test_list_run_artifacts_empty_for_freshly_created_run(client: AsyncClient) -> None:
    project = await _create_project(client)
    created = await _create_run(client, project["id"])

    response = await client.get(f"/api/v1/runs/{created['id']}/artifacts")
    assert response.status_code == 200
    body = response.json()
    assert body["items"] == []
    assert body["total"] == 0


async def test_list_run_artifacts_404_for_missing_run(client: AsyncClient) -> None:
    response = await client.get(f"/api/v1/runs/{uuid.uuid4()}/artifacts")
    assert response.status_code == 404


async def test_get_run_resumable_false_before_execution(client: AsyncClient) -> None:
    project = await _create_project(client)
    created = await _create_run(client, project["id"])

    assert created["resumable"] is False


async def test_run_repository_update_raises_not_found_when_row_vanishes(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """Regression for issue #62: `SqlAlchemyRunRepository.update` used to
    `assert record is not None` when the row disappeared between the
    caller's read and this write (e.g. a concurrent hard delete) - a bare
    `AssertionError` (an unhandled 500 that, under `python -O`, vanishes
    entirely and lets the next line raise a confusing `AttributeError`
    instead). Must raise a proper `NotFound` (404-mapped) error instead."""
    project = await _create_project(client)
    run = await _create_run(client, project["id"])
    run_id = uuid.UUID(run["id"])

    async with session_factory() as session:
        baseline = await SqlAlchemyRunRepository(session).get(run_id)
    assert baseline is not None

    async with session_factory() as session:
        record = await session.get(RunRecord, run_id)
        assert record is not None
        await session.delete(record)
        await session.commit()

    async with session_factory() as session:
        with pytest.raises(NotFound):
            await SqlAlchemyRunRepository(session).update(baseline)
