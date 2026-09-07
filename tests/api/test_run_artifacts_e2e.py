"""End-to-end coverage for issue #10: a real `outline="project"` run through
`GenerationService.execute` (fake CLI) should upload artifacts, sync the
generated content back onto the real outline nodes it was rendered from, and
update attached sources' chunk counts - exercised over HTTP like
`test_runs_sse.py` does, plus `sweep_stale_work_dirs` and the `resumable`
flag it feeds."""

from __future__ import annotations

import io
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.application.runs import GenerationService, sweep_stale_work_dirs
from api.core.settings import Settings, get_settings
from api.domain.models import (
    OutputFormat,
    Project,
    Run,
    RunKind,
    RunOptions,
    RunStatus,
    TargetAudience,
)
from api.infrastructure.db.file_repository import SqlAlchemyFileRepository
from api.infrastructure.db.outline_repository import SqlAlchemyOutlineRepository
from api.infrastructure.db.repositories import SqlAlchemyProjectRepository
from api.infrastructure.db.run_artifact_repository import SqlAlchemyRunArtifactRepository
from api.infrastructure.db.run_repository import SqlAlchemyRunEventRepository, SqlAlchemyRunRepository
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


async def test_execute_with_outline_project_syncs_content_artifacts_and_sources(
    app,
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    app.dependency_overrides[get_settings] = lambda: _settings(tmp_path)

    project_response = await client.post("/api/v1/projects", json=MINIMAL_PROJECT)
    assert project_response.status_code == 201
    project_id = project_response.json()["id"]

    # A two-node outline: "Ch A" (root) and "Ch B" (root) - the fake CLI
    # mirrors this back as cli_keys "1"/"2" (`StructureBuilder.build` ->
    # `book_builder.py`'s key scheme), so this exercises the real
    # `outline="project"` path end to end, not the fake CLI's own mock.
    node_a = await client.post(
        f"/api/v1/projects/{project_id}/outline", json={"title": "Ch A", "targetPages": 2}
    )
    assert node_a.status_code == 201
    node_b = await client.post(
        f"/api/v1/projects/{project_id}/outline", json={"title": "Ch B", "targetPages": 3}
    )
    assert node_b.status_code == 201

    upload = await client.post(
        "/api/v1/files",
        files={"file": ("notes.md", io.BytesIO(b"# Notes\n\nBackground material.\n"), "text/markdown")},
    )
    assert upload.status_code == 201
    file_id = upload.json()["id"]
    source_response = await client.post(
        f"/api/v1/projects/{project_id}/sources", json={"fileId": file_id}
    )
    assert source_response.status_code == 201
    source_id = source_response.json()["id"]

    run_response = await client.post(
        f"/api/v1/projects/{project_id}/runs", json={"outline": "project"}
    )
    assert run_response.status_code == 202
    run_id = run_response.json()["id"]

    finished = await _drive_generation(run_id, session_factory, file_storage, _settings(tmp_path))
    assert finished.status == RunStatus.succeeded

    # Artifacts.
    artifacts_response = await client.get(f"/api/v1/runs/{run_id}/artifacts")
    assert artifacts_response.status_code == 200
    artifacts_body = artifacts_response.json()
    kinds = {item["kind"] for item in artifacts_body["items"]}
    assert {"markdown", "structure_graph", "book_structure", "run_meta", "llm_usage", "kb_sources", "section"} <= kinds
    for item in artifacts_body["items"]:
        content = await client.get(f"/api/v1/files/{item['fileId']}/content")
        assert content.status_code == 200

    # Outline sync-back.
    outline_response = await client.get(f"/api/v1/projects/{project_id}/outline")
    assert outline_response.status_code == 200
    nodes_by_id = {n["id"]: n for n in outline_response.json()["items"]}
    for node_id in (node_a.json()["id"], node_b.json()["id"]):
        node = nodes_by_id[node_id]
        assert node["status"] == "compiled"
        assert node["contentMarkdown"].strip() != ""
        assert node["actualWords"] > 0

    # Source chunk counts.
    source_after = await client.get(f"/api/v1/projects/{project_id}/sources/{source_id}")
    assert source_after.status_code == 200
    assert source_after.json()["chunksCount"] == 1
    assert source_after.json()["status"] == "indexed"

    # project.lastRunId re-affirmed on success.
    project_after = await client.get(f"/api/v1/projects/{project_id}")
    assert project_after.json()["lastRunId"] == run_id

    # resumable while the work dir is still on disk.
    run_after = await client.get(f"/api/v1/runs/{run_id}")
    assert run_after.json()["resumable"] is True


async def test_run_is_not_resumable_before_it_has_ever_executed(client: AsyncClient) -> None:
    project_response = await client.post("/api/v1/projects", json=MINIMAL_PROJECT)
    project_id = project_response.json()["id"]
    run_response = await client.post(f"/api/v1/projects/{project_id}/runs", json={})

    assert run_response.json()["resumable"] is False


def _make_project(**overrides):
    now = datetime.now(timezone.utc)
    defaults = dict(
        id=uuid.uuid4(),
        owner_id=None,
        title="AI in Teaching",
        subtitle="A practical guide",
        authors=["Ada Lovelace"],
        topic="using AI tools",
        target_audience=TargetAudience.GRADUATE,
        total_pages_budget=120,
        equation_frequency_level=2,
        do_consider_outline=True,
        do_consider_previous_sections=True,
        output_format=OutputFormat.MARKDOWN,
        max_outline_levels=3,
        additional_requirements=None,
        last_run_id=None,
        created_at=now,
        updated_at=now,
    )
    defaults.update(overrides)
    return Project(**defaults)


def _make_run(project_id: uuid.UUID, work_dir: Path, **overrides):
    now = datetime.now(timezone.utc)
    defaults = dict(
        id=uuid.uuid4(),
        project_id=project_id,
        kind=RunKind.full,
        status=RunStatus.succeeded,
        options=RunOptions(outline="generate", output_format="markdown"),
        base_run_id=None,
        target_node_id=None,
        target_node_previous_status=None,
        work_dir=str(work_dir),
        exit_code=0,
        error=None,
        cancel_requested=False,
        locked_by=None,
        heartbeat_at=None,
        queued_at=now,
        started_at=now,
        finished_at=now,
        total_tokens=None,
        total_cost_usd=None,
    )
    defaults.update(overrides)
    return Run(**defaults)


async def test_sweep_stale_work_dirs_removes_old_terminal_run_dirs(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    old_work_dir = tmp_path / "old-run"
    old_work_dir.mkdir()
    (old_work_dir / "marker.txt").write_text("x", encoding="utf-8")
    recent_work_dir = tmp_path / "recent-run"
    recent_work_dir.mkdir()

    long_ago = datetime.now(timezone.utc) - timedelta(days=60)
    recently = datetime.now(timezone.utc) - timedelta(minutes=5)

    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        run_repo = SqlAlchemyRunRepository(session)
        old_run = await run_repo.add(
            _make_run(project.id, old_work_dir, finished_at=long_ago, queued_at=long_ago)
        )
        recent_run = await run_repo.add(
            _make_run(project.id, recent_work_dir, finished_at=recently, queued_at=recently)
        )

        removed = await sweep_stale_work_dirs(run_repo, retention_days=30)

    assert removed == 1
    assert not old_work_dir.exists()
    assert recent_work_dir.exists()
    assert old_run.id != recent_run.id


async def test_sweep_stale_work_dirs_keeps_a_dir_a_running_sibling_run_still_uses(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    """issue #64: `regenerate_section`/`export` runs reuse their base run's
    `work_dir` verbatim (`RunService.regenerate_node`/`export`). A base
    `full` run that succeeded 60 days ago must not have its directory
    swept out from under a `regenerate_section` run that's still `running`
    in it right now."""
    shared_work_dir = tmp_path / "shared-run"
    shared_work_dir.mkdir()

    long_ago = datetime.now(timezone.utc) - timedelta(days=60)

    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        run_repo = SqlAlchemyRunRepository(session)
        base_run = await run_repo.add(
            _make_run(project.id, shared_work_dir, finished_at=long_ago, queued_at=long_ago)
        )
        running_regenerate = await run_repo.add(
            _make_run(
                project.id,
                shared_work_dir,
                kind=RunKind.regenerate_section,
                base_run_id=base_run.id,
                status=RunStatus.running,
                finished_at=None,
                queued_at=datetime.now(timezone.utc),
            )
        )

        removed = await sweep_stale_work_dirs(run_repo, retention_days=30)

    assert removed == 0
    assert shared_work_dir.exists()
    assert running_regenerate.status == RunStatus.running


async def test_sweep_stale_work_dirs_uses_the_newest_finished_at_across_a_shared_dir(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    """issue #64: a `full` run finished 60 days ago and a later, succeeded
    `export` from yesterday sharing the same `work_dir` should keep that
    directory - the group's most recent activity is what matters, not the
    original run's age. Once every run sharing the directory is old enough,
    it's removed exactly once."""
    shared_work_dir = tmp_path / "shared-run"
    shared_work_dir.mkdir()

    long_ago = datetime.now(timezone.utc) - timedelta(days=60)
    yesterday = datetime.now(timezone.utc) - timedelta(days=1)

    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        run_repo = SqlAlchemyRunRepository(session)
        base_run = await run_repo.add(
            _make_run(project.id, shared_work_dir, finished_at=long_ago, queued_at=long_ago)
        )
        export_run = await run_repo.add(
            _make_run(
                project.id,
                shared_work_dir,
                kind=RunKind.export,
                base_run_id=base_run.id,
                finished_at=yesterday,
                queued_at=yesterday,
            )
        )

        removed_too_soon = await sweep_stale_work_dirs(run_repo, retention_days=30)
        assert removed_too_soon == 0
        assert shared_work_dir.exists()

        # Once the group's newest `finished_at` (yesterday) is itself older
        # than the cutoff, the whole shared directory is removed exactly
        # once - not once per run referencing it.
        removed = await sweep_stale_work_dirs(run_repo, retention_days=0.5)

    assert removed == 1
    assert not shared_work_dir.exists()
    assert export_run.id != base_run.id
