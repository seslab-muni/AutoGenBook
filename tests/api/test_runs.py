from __future__ import annotations

import uuid

from httpx import AsyncClient

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


async def test_create_run_sets_project_last_run_id(client: AsyncClient) -> None:
    project = await _create_project(client)
    run = await _create_run(client, project["id"])

    response = await client.get(f"/api/v1/projects/{project['id']}")
    assert response.status_code == 200
    assert response.json()["lastRunId"] == run["id"]


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
