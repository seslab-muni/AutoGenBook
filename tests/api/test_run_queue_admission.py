"""Coverage for issue #134's admission rules: `queue_admission_blocker`
(unit, no DB) plus the HTTP-level 409/202 behavior it drives for
`create`/`regenerate_node`/`export`/`retry` - a project may hold several
`queued` runs at once now (`MAX_QUEUED_RUNS_PER_PROJECT`, default 5), but a
`regenerate_section`/`export`/`retry` is blocked outright by a `full` run
already queued or running, since both are relative to a base work
directory/`project.last_run_id` a later `full` run would rewrite out from
under them.
"""

from __future__ import annotations

import sys
import uuid
from dataclasses import replace as dataclass_replace
from datetime import datetime, timezone
from pathlib import Path

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.application.runs import GenerationService, queue_admission_blocker
from api.core.settings import Settings, get_settings
from api.domain.models import Run, RunKind, RunOptions, RunStatus
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
        run = await SqlAlchemyRunQueue(session).claim("test-worker")
        assert run is not None and str(run.id) == run_id
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
            worker_id="test-worker",
        )
        return await service.execute(run)


async def _create_project(authed_client: AsyncClient, **overrides) -> dict:
    payload = {**MINIMAL_PROJECT, **overrides}
    response = await authed_client.post("/api/v1/projects", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def _create_node(authed_client: AsyncClient, project_id: str, title: str, **overrides) -> dict:
    payload = {"title": title, "targetPages": 2, **overrides}
    response = await authed_client.post(f"/api/v1/projects/{project_id}/outline", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def _run_full(
    authed_client: AsyncClient,
    project_id: str,
    session_factory: async_sessionmaker[AsyncSession],
    storage,
    settings: Settings,
    **overrides,
) -> dict:
    response = await authed_client.post(
        f"/api/v1/projects/{project_id}/runs", json={"outline": "project", **overrides}
    )
    assert response.status_code == 202, response.text
    run = response.json()
    finished = await _drive_generation(run["id"], session_factory, storage, settings)
    assert finished.status.value == "succeeded", finished.error
    return run


def _lane_run(kind: RunKind, status: RunStatus) -> Run:
    now = datetime.now(timezone.utc)
    return Run(
        id=uuid.uuid4(),
        project_id=uuid.uuid4(),
        kind=kind,
        status=status,
        options=RunOptions(outline="project"),
        base_run_id=None,
        target_node_id=None,
        target_node_previous_status=None,
        work_dir="/app/runs/x",
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


# --- queue_admission_blocker (pure function) --------------------------------


def test_admission_allows_a_full_run_with_an_empty_lane() -> None:
    assert queue_admission_blocker(blocked_by_full_run=False, lane_runs=[], cap=5) is None


def test_admission_allows_a_full_run_behind_a_queued_regenerate() -> None:
    # `create`'s `full` run passes `blocked_by_full_run=False` - it reads
    # the project/outline fresh when it starts, so nothing already in the
    # lane can block it, only the cap.
    lane = [_lane_run(RunKind.regenerate_section, RunStatus.queued)]
    assert queue_admission_blocker(blocked_by_full_run=False, lane_runs=lane, cap=5) is None


def test_admission_allows_a_full_run_behind_another_queued_full_run() -> None:
    lane = [_lane_run(RunKind.full, RunStatus.running), _lane_run(RunKind.full, RunStatus.queued)]
    assert queue_admission_blocker(blocked_by_full_run=False, lane_runs=lane, cap=5) is None


def test_admission_allows_chained_regenerates_behind_each_other() -> None:
    lane = [
        _lane_run(RunKind.regenerate_section, RunStatus.running),
        _lane_run(RunKind.regenerate_section, RunStatus.queued),
        _lane_run(RunKind.export, RunStatus.queued),
    ]
    assert queue_admission_blocker(blocked_by_full_run=True, lane_runs=lane, cap=5) is None


def test_admission_blocks_regenerate_behind_a_queued_full_run() -> None:
    lane = [_lane_run(RunKind.full, RunStatus.queued)]
    blocker = queue_admission_blocker(blocked_by_full_run=True, lane_runs=lane, cap=5)
    assert blocker is not None
    assert "full run" in blocker


def test_admission_blocks_export_behind_a_running_full_run() -> None:
    lane = [_lane_run(RunKind.full, RunStatus.running)]
    blocker = queue_admission_blocker(blocked_by_full_run=True, lane_runs=lane, cap=5)
    assert blocker is not None
    assert "full run" in blocker


def test_admission_blocks_retry_behind_a_queued_full_run() -> None:
    # `RunService.retry` creates a `kind == full` run, but - unlike
    # `create`'s run - it resumes an *existing* `work_dir`, exactly the way
    # `regenerate_section`/`export` do, so it passes `blocked_by_full_run=
    # True` like they do and is blocked by another full run in the lane
    # (issue #134 review: retry used to be admitted unconditionally here,
    # which let two retries of the same failed run both queue and race to
    # resume the same work directory).
    lane = [_lane_run(RunKind.full, RunStatus.queued)]
    blocker = queue_admission_blocker(blocked_by_full_run=True, lane_runs=lane, cap=5)
    assert blocker is not None
    assert "full run" in blocker


def test_admission_a_queued_retry_blocks_a_later_regenerate_too() -> None:
    # A queued retry is `kind == full`, so it counts as "a full run in the
    # lane" for everything queued behind it, the same as a `create`d run.
    lane = [_lane_run(RunKind.full, RunStatus.queued)]  # stands in for a queued retry
    blocker = queue_admission_blocker(blocked_by_full_run=True, lane_runs=lane, cap=5)
    assert blocker is not None


def test_admission_blocks_once_the_cap_is_reached() -> None:
    lane = [_lane_run(RunKind.regenerate_section, RunStatus.queued) for _ in range(3)]
    blocker = queue_admission_blocker(blocked_by_full_run=True, lane_runs=lane, cap=3)
    assert blocker is not None
    assert "queue is full" in blocker
    assert queue_admission_blocker(blocked_by_full_run=True, lane_runs=lane, cap=4) is None


def test_admission_full_run_check_takes_priority_over_the_cap_message() -> None:
    lane = [_lane_run(RunKind.full, RunStatus.queued)] + [
        _lane_run(RunKind.regenerate_section, RunStatus.queued) for _ in range(4)
    ]
    blocker = queue_admission_blocker(blocked_by_full_run=True, lane_runs=lane, cap=5)
    assert blocker is not None
    assert "full run" in blocker


# --- HTTP-level integration --------------------------------------------------


async def test_regenerate_409_when_a_full_run_is_already_queued(
    app,
    authed_client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings

    project = await _create_project(authed_client)
    project_id = project["id"]
    node = await _create_node(authed_client, project_id, "Chapter A")
    await _run_full(authed_client, project_id, session_factory, file_storage, settings)

    # Queue a second full run without driving it.
    queued = await authed_client.post(
        f"/api/v1/projects/{project_id}/runs", json={"outline": "project"}
    )
    assert queued.status_code == 202, queued.text

    response = await authed_client.post(
        f"/api/v1/projects/{project_id}/outline/{node['id']}/regenerate", json={}
    )
    assert response.status_code == 409
    assert "full run" in response.json()["detail"]


async def test_regenerate_and_export_can_chain_behind_each_other(
    app,
    authed_client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings

    project = await _create_project(authed_client)
    project_id = project["id"]
    node_a = await _create_node(authed_client, project_id, "Chapter A")
    node_b = await _create_node(authed_client, project_id, "Chapter B")
    await _run_full(authed_client, project_id, session_factory, file_storage, settings)

    first = await authed_client.post(
        f"/api/v1/projects/{project_id}/outline/{node_a['id']}/regenerate", json={}
    )
    assert first.status_code == 202, first.text
    assert first.json()["queuePosition"] == 1

    second = await authed_client.post(
        f"/api/v1/projects/{project_id}/outline/{node_b['id']}/regenerate", json={}
    )
    assert second.status_code == 202, second.text
    assert second.json()["queuePosition"] == 2


async def test_create_run_202_behind_a_queued_regenerate(
    app,
    authed_client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    """A `full` run is never blocked by anything already in the lane - only
    the cap applies to it."""
    settings = _settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings

    project = await _create_project(authed_client)
    project_id = project["id"]
    node = await _create_node(authed_client, project_id, "Chapter A")
    await _run_full(authed_client, project_id, session_factory, file_storage, settings)

    regenerate = await authed_client.post(
        f"/api/v1/projects/{project_id}/outline/{node['id']}/regenerate", json={}
    )
    assert regenerate.status_code == 202, regenerate.text

    full = await authed_client.post(
        f"/api/v1/projects/{project_id}/runs", json={"outline": "project"}
    )
    assert full.status_code == 202, full.text


async def test_list_runs_status_filter(
    app,
    authed_client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings

    project = await _create_project(authed_client)
    project_id = project["id"]
    await _run_full(authed_client, project_id, session_factory, file_storage, settings)
    await authed_client.post(f"/api/v1/projects/{project_id}/runs", json={"outline": "project"})

    response = await authed_client.get(
        f"/api/v1/projects/{project_id}/runs", params={"status": "queued"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert all(run["status"] == "queued" for run in body["items"])

    response_multi = await authed_client.get(
        f"/api/v1/projects/{project_id}/runs",
        params=[("status", "queued"), ("status", "succeeded")],
    )
    assert response_multi.status_code == 200
    assert response_multi.json()["total"] == 2


async def _fail_run(session_factory: async_sessionmaker[AsyncSession], run_id: str) -> None:
    async with session_factory() as session:
        repo = SqlAlchemyRunRepository(session)
        run = await repo.get(uuid.UUID(run_id))
        assert run is not None
        await repo.update(
            dataclass_replace(run, status=RunStatus.failed, exit_code=-9, error="killed")
        )


async def test_retry_409_when_a_full_run_is_already_queued(
    app,
    authed_client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    """Issue #134 review: `retry` creates a `kind=full` run, but it resumes
    the *original* run's `work_dir` - unlike `create`'s run, it's just as
    dependent on a fixed base directory as `regenerate_section`/`export`
    are, so it must be blocked by another queued/running full run the same
    way. Regression for a bug where retry was admitted unconditionally: two
    retries of the same failed run would both queue and both resume the
    same `work_dir`."""
    settings = _settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings

    project = await _create_project(authed_client)
    project_id = project["id"]
    await _create_node(authed_client, project_id, "Chapter A")
    base_run = await _run_full(authed_client, project_id, session_factory, file_storage, settings)
    await _fail_run(session_factory, base_run["id"])

    first_retry = await authed_client.post(f"/api/v1/runs/{base_run['id']}/retry")
    assert first_retry.status_code == 202, first_retry.text

    second_retry = await authed_client.post(f"/api/v1/runs/{base_run['id']}/retry")
    assert second_retry.status_code == 409
    assert "full run" in second_retry.json()["detail"]


async def test_regenerate_409_when_the_same_node_already_has_one_queued(
    app,
    authed_client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    """Issue #134 review: the issue's own admission table assumed a second
    `regenerate` on the same node was "already covered" by the node being
    `drafting`, but nothing actually checked that - regression for a bug
    where two regenerate requests for the same node could both queue,
    leaving the node stuck at `drafting` once both finished/were
    cancelled."""
    settings = _settings(tmp_path)
    app.dependency_overrides[get_settings] = lambda: settings

    project = await _create_project(authed_client)
    project_id = project["id"]
    node = await _create_node(authed_client, project_id, "Chapter A")
    await _run_full(authed_client, project_id, session_factory, file_storage, settings)

    first = await authed_client.post(
        f"/api/v1/projects/{project_id}/outline/{node['id']}/regenerate", json={}
    )
    assert first.status_code == 202, first.text

    second = await authed_client.post(
        f"/api/v1/projects/{project_id}/outline/{node['id']}/regenerate", json={}
    )
    assert second.status_code == 409
    assert "regenerate" in second.json()["detail"]

    node_after = await authed_client.get(f"/api/v1/projects/{project_id}/outline/{node['id']}")
    assert node_after.json()["status"] == "drafting"
