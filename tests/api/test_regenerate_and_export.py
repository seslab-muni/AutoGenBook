"""Coverage for issue #11: per-node regeneration (with an optional prompt
modifier) and LaTeX/PDF exports built on the CLI's own `--resume`, both
reusing a finished run's work directory instead of the CLI adapter having to
grow anything new - exercised over HTTP + a driven `GenerationService.execute`
like `test_run_artifacts_e2e.py`, plus the 409 guards that keep a
`regenerate`/`export` run from starting somewhere unsafe.
"""

from __future__ import annotations

import shutil
import sys
import uuid
from pathlib import Path

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from dataclasses import replace as dataclass_replace
from datetime import datetime, timezone

from api.application.runs import GenerationService
from api.core.settings import Settings, get_settings
from api.domain.models import NodeStatus, Run, RunKind, RunStatus
from api.infrastructure.db.file_repository import SqlAlchemyFileRepository
from api.infrastructure.db.outline_repository import SqlAlchemyOutlineRepository
from api.infrastructure.db.repositories import SqlAlchemyProjectRepository
from api.infrastructure.db.run_artifact_repository import SqlAlchemyRunArtifactRepository
from api.infrastructure.db.run_repository import (
    SqlAlchemyRunEventRepository,
    SqlAlchemyRunRepository,
)
from api.infrastructure.db.source_repository import SqlAlchemySourceRepository
from api.infrastructure.queue.postgres import SqlAlchemyRunQueue
from api.infrastructure.storage.memory import InMemoryFileStorage

REPO_ROOT = Path(__file__).resolve().parents[2]
FAKE_CLI = Path(__file__).resolve().with_name("fake_cli.py")

MINIMAL_PROJECT = {
    "title": "Intro to Widgets",
    "subtitle": "A Practical Guide",
    "authors": ["Ada Lovelace"],
    "topic": "widgets",
}


def _settings(tmp_path: Path, **overrides) -> Settings:
    defaults = dict(
        cli_python=sys.executable,
        cli_entrypoint=str(FAKE_CLI),
        repo_root=str(REPO_ROOT),
        runs_dir=str(tmp_path),
    )
    defaults.update(overrides)
    return Settings(**defaults)


async def _drive_generation(
    run_id: str, session_factory: async_sessionmaker[AsyncSession], storage, settings: Settings
):
    async with session_factory() as session:
        run = await SqlAlchemyRunRepository(session).get(uuid.UUID(run_id))
        assert run is not None
        service = GenerationService(
            run_repository=SqlAlchemyRunRepository(session),
            run_event_repository=SqlAlchemyRunEventRepository(session),
            run_queue=SqlAlchemyRunQueue(session),
            project_repository=SqlAlchemyProjectRepository(session),
            outline_repository=SqlAlchemyOutlineRepository(session),
            source_repository=SqlAlchemySourceRepository(session),
            file_repository=SqlAlchemyFileRepository(session),
            file_storage=storage,
            run_artifact_repository=SqlAlchemyRunArtifactRepository(session),
            settings=settings,
            drain_poll_interval_s=0.05,
        )
        return await service.execute(run)


async def _create_project(client: AsyncClient, **overrides) -> dict:
    payload = {**MINIMAL_PROJECT, **overrides}
    response = await client.post("/api/v1/projects", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def _create_node(client: AsyncClient, project_id: str, title: str, **overrides) -> dict:
    payload = {"title": title, "targetPages": 2, **overrides}
    response = await client.post(f"/api/v1/projects/{project_id}/outline", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def _run_full(
    client: AsyncClient,
    project_id: str,
    session_factory: async_sessionmaker[AsyncSession],
    storage,
    settings: Settings,
    **overrides,
) -> dict:
    response = await client.post(
        f"/api/v1/projects/{project_id}/runs", json={"outline": "project", **overrides}
    )
    assert response.status_code == 202, response.text
    run = response.json()
    finished = await _drive_generation(run["id"], session_factory, storage, settings)
    assert finished.status.value == "succeeded", finished.error
    return run


async def _get_node(client: AsyncClient, project_id: str, node_id: str) -> dict:
    response = await client.get(f"/api/v1/projects/{project_id}/outline/{node_id}")
    assert response.status_code == 200
    return response.json()


async def test_regenerate_end_to_end_touches_only_the_target_node(
    app,
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings

    project = await _create_project(client)
    project_id = project["id"]
    node_a = await _create_node(client, project_id, "Chapter A")
    node_b = await _create_node(client, project_id, "Chapter B")

    base_run = await _run_full(client, project_id, session_factory, file_storage, settings)

    node_a_before = await _get_node(client, project_id, node_a["id"])
    node_b_before = await _get_node(client, project_id, node_b["id"])
    assert node_a_before["contentMarkdown"].strip() != ""

    regen_response = await client.post(
        f"/api/v1/projects/{project_id}/outline/{node_a['id']}/regenerate",
        json={"promptModifier": "add worked examples"},
    )
    assert regen_response.status_code == 202, regen_response.text
    regen_run = regen_response.json()
    assert regen_run["kind"] == "regenerate_section"
    assert regen_run["baseRunId"] == base_run["id"]
    assert regen_run["targetNodeId"] == node_a["id"]
    assert regen_run["options"]["resume"] is True
    assert regen_run["options"]["promptModifier"] == "add worked examples"

    # The node flips to "drafting" as soon as the run is created, before the
    # worker has even picked it up.
    node_a_drafting = await _get_node(client, project_id, node_a["id"])
    assert node_a_drafting["status"] == "drafting"

    finished = await _drive_generation(regen_run["id"], session_factory, file_storage, settings)
    assert finished.status.value == "succeeded", finished.error

    events_response = await client.get(f"/api/v1/runs/{regen_run['id']}/events?limit=1000")
    assert events_response.status_code == 200
    section_events = [e for e in events_response.json()["items"] if e["stage"] == "section"]
    assert len(section_events) == 1

    node_a_after = await _get_node(client, project_id, node_a["id"])
    node_b_after = await _get_node(client, project_id, node_b["id"])

    assert node_a_after["status"] == "compiled"
    assert "Writing instructions: add worked examples" in node_a_after["contentMarkdown"]
    assert node_a_after["contentMarkdown"] != node_a_before["contentMarkdown"]
    assert node_a_after["updatedAt"] != node_a_before["updatedAt"]

    assert node_b_after["contentMarkdown"] == node_b_before["contentMarkdown"]
    assert node_b_after["updatedAt"] == node_b_before["updatedAt"]

    # A backup of the previous section content was kept.
    work_dir = Path(settings.runs_dir) / base_run["id"]
    regen_history = list((work_dir / "out" / "regen_history").glob("*.md.prev"))
    assert len(regen_history) == 1

    # project.lastRunId re-chains onto the regenerate run.
    project_after = await client.get(f"/api/v1/projects/{project_id}")
    assert project_after.json()["lastRunId"] == regen_run["id"]

    # New artifacts were uploaded for the regenerate run itself.
    artifacts_response = await client.get(f"/api/v1/runs/{regen_run['id']}/artifacts")
    assert artifacts_response.status_code == 200
    kinds = {item["kind"] for item in artifacts_response.json()["items"]}
    assert "section" in kinds


async def test_export_end_to_end_does_not_regenerate_sections(
    app,
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings

    project = await _create_project(client)
    project_id = project["id"]
    node = await _create_node(client, project_id, "Chapter A")

    base_run = await _run_full(client, project_id, session_factory, file_storage, settings)
    node_before = await _get_node(client, project_id, node["id"])

    export_response = await client.post(
        f"/api/v1/runs/{base_run['id']}/exports", json={"format": "pdf"}
    )
    assert export_response.status_code == 202, export_response.text
    export_run = export_response.json()
    assert export_run["kind"] == "export"
    assert export_run["baseRunId"] == base_run["id"]
    assert export_run["targetNodeId"] is None
    assert export_run["options"]["exportTexOnly"] is True
    assert export_run["options"]["outputFormat"] == "pdf"

    finished = await _drive_generation(export_run["id"], session_factory, file_storage, settings)
    assert finished.status.value == "succeeded", finished.error

    events_response = await client.get(f"/api/v1/runs/{export_run['id']}/events?limit=1000")
    section_events = [e for e in events_response.json()["items"] if e["stage"] == "section"]
    assert section_events == []

    artifacts_response = await client.get(f"/api/v1/runs/{export_run['id']}/artifacts")
    kinds = {item["kind"] for item in artifacts_response.json()["items"]}
    assert {"tex", "pdf"} <= kinds

    node_after = await _get_node(client, project_id, node["id"])
    assert node_after["contentMarkdown"] == node_before["contentMarkdown"]
    assert node_after["updatedAt"] == node_before["updatedAt"]

    # export doesn't chain project.lastRunId - a later regenerate should
    # still resolve its base run from the original full run.
    project_after = await client.get(f"/api/v1/projects/{project_id}")
    assert project_after.json()["lastRunId"] == base_run["id"]


async def test_regenerate_resolves_previous_succeeded_run_after_a_later_run_never_succeeds(
    app,
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    """issue #66: `RunService.create` used to set `project.lastRunId` to the
    just-queued run immediately, at queue time - before it had any chance to
    succeed. `_resolvable_base_run` (regenerate/export) treats `lastRunId` as
    "the base to resume from", so a full run started after an earlier one
    succeeded, that itself never succeeds (cancelled here before the worker
    even claims it, same as a run that fails or is simply still queued),
    permanently overwrote `lastRunId` and made every subsequent
    regenerate/export 409 - even though the first run's succeeded work dir
    was still on disk and perfectly resumable."""
    settings = _settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings

    project = await _create_project(client)
    project_id = project["id"]
    node = await _create_node(client, project_id, "Chapter A")

    base_run = await _run_full(client, project_id, session_factory, file_storage, settings)

    second_run_response = await client.post(
        f"/api/v1/projects/{project_id}/runs", json={"outline": "project"}
    )
    assert second_run_response.status_code == 202, second_run_response.text
    second_run = second_run_response.json()

    # Queueing the second run must not overwrite `lastRunId` before it has
    # actually succeeded.
    project_after_queue = await client.get(f"/api/v1/projects/{project_id}")
    assert project_after_queue.json()["lastRunId"] == base_run["id"]

    cancel_response = await client.post(f"/api/v1/runs/{second_run['id']}/cancel")
    assert cancel_response.status_code == 202, cancel_response.text
    assert cancel_response.json()["status"] == "cancelled"

    project_after_cancel = await client.get(f"/api/v1/projects/{project_id}")
    assert project_after_cancel.json()["lastRunId"] == base_run["id"]

    regen_response = await client.post(
        f"/api/v1/projects/{project_id}/outline/{node['id']}/regenerate", json={}
    )
    assert regen_response.status_code == 202, regen_response.text
    assert regen_response.json()["baseRunId"] == base_run["id"]


async def test_regenerate_404_for_missing_node(
    app, client: AsyncClient, tmp_path: Path
) -> None:
    app.dependency_overrides[get_settings] = lambda: _settings(tmp_path)
    project = await _create_project(client)
    response = await client.post(
        f"/api/v1/projects/{project['id']}/outline/"
        f"00000000-0000-0000-0000-000000000000/regenerate",
        json={},
    )
    assert response.status_code == 404


async def test_regenerate_409_when_no_previous_run(
    app, client: AsyncClient, tmp_path: Path
) -> None:
    app.dependency_overrides[get_settings] = lambda: _settings(tmp_path)
    project = await _create_project(client)
    node = await _create_node(client, project["id"], "Chapter A")

    response = await client.post(
        f"/api/v1/projects/{project['id']}/outline/{node['id']}/regenerate", json={}
    )
    assert response.status_code == 409


async def test_regenerate_409_when_outline_changed_since_base_run(
    app,
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings

    project = await _create_project(client)
    project_id = project["id"]
    node_a = await _create_node(client, project_id, "Chapter A")
    await _run_full(client, project_id, session_factory, file_storage, settings)

    # Structural edit after the base run: a new outline node.
    await _create_node(client, project_id, "Chapter C (added later)")

    response = await client.post(
        f"/api/v1/projects/{project_id}/outline/{node_a['id']}/regenerate", json={}
    )
    assert response.status_code == 409


async def test_regenerate_409_when_project_has_an_active_run(
    app,
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings

    project = await _create_project(client)
    project_id = project["id"]
    node = await _create_node(client, project_id, "Chapter A")
    await _run_full(client, project_id, session_factory, file_storage, settings)

    # A second run left queued (never driven) is still "active".
    await client.post(f"/api/v1/projects/{project_id}/runs", json={"outline": "project"})

    response = await client.post(
        f"/api/v1/projects/{project_id}/outline/{node['id']}/regenerate", json={}
    )
    assert response.status_code == 409


async def test_export_409_when_base_run_not_succeeded(
    app, client: AsyncClient, tmp_path: Path
) -> None:
    app.dependency_overrides[get_settings] = lambda: _settings(tmp_path)
    project = await _create_project(client)
    run_response = await client.post(
        f"/api/v1/projects/{project['id']}/runs", json={"outline": "project"}
    )
    run = run_response.json()  # left "queued" - never driven.

    response = await client.post(f"/api/v1/runs/{run['id']}/exports", json={"format": "pdf"})
    assert response.status_code == 409


async def test_export_404_for_missing_run(app, client: AsyncClient, tmp_path: Path) -> None:
    app.dependency_overrides[get_settings] = lambda: _settings(tmp_path)
    response = await client.post(
        "/api/v1/runs/00000000-0000-0000-0000-000000000000/exports",
        json={"format": "latex"},
    )
    assert response.status_code == 404


async def test_regenerate_reverts_node_status_when_the_run_fails(
    app,
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings

    project = await _create_project(client)
    project_id = project["id"]
    node = await _create_node(client, project_id, "Chapter A")
    base_run = await _run_full(client, project_id, session_factory, file_storage, settings)

    node_before = await _get_node(client, project_id, node["id"])
    assert node_before["status"] == "compiled"

    regen_response = await client.post(
        f"/api/v1/projects/{project_id}/outline/{node['id']}/regenerate", json={}
    )
    regen_run = regen_response.json()

    node_drafting = await _get_node(client, project_id, node["id"])
    assert node_drafting["status"] == "drafting"

    # Sabotage the work directory the regenerate run was meant to reuse, so
    # `GenerationService._prepare_regenerate` fails before the CLI even
    # runs.
    shutil.rmtree(Path(settings.runs_dir) / base_run["id"])

    finished = await _drive_generation(regen_run["id"], session_factory, file_storage, settings)
    assert finished.status.value == "failed"

    node_after = await _get_node(client, project_id, node["id"])
    assert node_after["status"] == "compiled"


async def test_cancelling_a_queued_regenerate_run_reverts_the_node_status(
    app,
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    """issue #63: `regenerate_node` flips the target node to `drafting`
    immediately, before the worker ever claims the run - if the run is
    cancelled while still `queued`, the worker's own `_revert_node_status`
    never gets a chance to run, and the node stayed at `drafting` forever."""
    settings = _settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings

    project = await _create_project(client)
    project_id = project["id"]
    node = await _create_node(client, project_id, "Chapter A")
    await _run_full(client, project_id, session_factory, file_storage, settings)

    node_before = await _get_node(client, project_id, node["id"])
    assert node_before["status"] == "compiled"

    regen_response = await client.post(
        f"/api/v1/projects/{project_id}/outline/{node['id']}/regenerate", json={}
    )
    regen_run = regen_response.json()

    node_drafting = await _get_node(client, project_id, node["id"])
    assert node_drafting["status"] == "drafting"

    cancel_response = await client.post(f"/api/v1/runs/{regen_run['id']}/cancel")
    assert cancel_response.status_code == 202
    assert cancel_response.json()["status"] == "cancelled"

    node_after = await _get_node(client, project_id, node["id"])
    assert node_after["status"] == "compiled"

    events_response = await client.get(f"/api/v1/runs/{regen_run['id']}/events")
    assert events_response.json()["total"] == 1
    assert events_response.json()["items"][0]["stage"] == "done"


async def test_regenerate_409_for_a_non_leaf_node(
    app,
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    """issue #77: the CLI only ever writes `sections/<key>.md` for leaves,
    so regenerating a parent node would run a full CLI invocation,
    `--resume` every leaf, "succeed", import nothing, and leave the node
    stuck at `drafting` forever. Reject it outright instead."""
    settings = _settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings

    project = await _create_project(client)
    project_id = project["id"]
    parent = await _create_node(client, project_id, "Chapter A")
    await _create_node(client, project_id, "Section A.1", parentId=parent["id"])

    await _run_full(client, project_id, session_factory, file_storage, settings)

    parent_before = await _get_node(client, project_id, parent["id"])
    assert parent_before["status"] == "not_started"

    response = await client.post(
        f"/api/v1/projects/{project_id}/outline/{parent['id']}/regenerate", json={}
    )
    assert response.status_code == 409

    parent_after = await _get_node(client, project_id, parent["id"])
    assert parent_after["status"] == "not_started"


async def test_regenerate_reverts_node_status_when_the_run_imports_no_content_change(
    app,
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    """Backstop half of issue #77's fix, exercised at the
    `GenerationService`/`import_single_node` layer directly (bypassing
    `RunService.regenerate_node`'s new 409, which already covers this for
    runs created through the API) - a `regenerate_section` run that
    "succeeds" without actually importing any content change must not
    leave its target node stuck at `drafting`."""
    settings = _settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings

    project = await _create_project(client)
    project_id = project["id"]
    parent = await _create_node(client, project_id, "Chapter A")
    await _create_node(client, project_id, "Section A.1", parentId=parent["id"])

    base_run = await _run_full(client, project_id, session_factory, file_storage, settings)

    parent_before = await _get_node(client, project_id, parent["id"])
    assert parent_before["status"] == "not_started"

    now = datetime.now(timezone.utc)
    async with session_factory() as session:
        base = await SqlAlchemyRunRepository(session).get(uuid.UUID(base_run["id"]))
        assert base is not None
        run = Run(
            id=uuid.uuid4(),
            project_id=uuid.UUID(project_id),
            kind=RunKind.regenerate_section,
            status=RunStatus.queued,
            options=dataclass_replace(base.options, resume=True),
            base_run_id=base.id,
            target_node_id=uuid.UUID(parent["id"]),
            target_node_previous_status=NodeStatus.NOT_STARTED,
            work_dir=base.work_dir,
            exit_code=None,
            error=None,
            cancel_requested=False,
            locked_by=None,
            heartbeat_at=None,
            queued_at=now,
            started_at=None,
            finished_at=None,
            total_tokens=None,
            total_cost_usd=None,
        )
        await SqlAlchemyRunRepository(session).add(run)

    finished = await _drive_generation(str(run.id), session_factory, file_storage, settings)
    assert finished.status.value == "succeeded", finished.error

    parent_after = await _get_node(client, project_id, parent["id"])
    assert parent_after["status"] == "not_started"

    project_after = await client.get(f"/api/v1/projects/{project_id}")
    assert project_after.json()["lastRunId"] == base_run["id"]
