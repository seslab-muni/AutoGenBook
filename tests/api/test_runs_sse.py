from __future__ import annotations

import asyncio
import sys
import uuid
from pathlib import Path

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.application.runs import GenerationService
from api.core.settings import Settings, get_settings
from api.infrastructure.db.file_repository import SqlAlchemyFileRepository
from api.infrastructure.db.outline_repository import SqlAlchemyOutlineRepository
from api.infrastructure.db.repositories import SqlAlchemyProjectRepository
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


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        cli_python=sys.executable,
        cli_entrypoint=str(FAKE_CLI),
        repo_root=str(REPO_ROOT),
        runs_dir=str(tmp_path),
    )


async def test_sse_stream_shows_section_and_done_events(
    app,
    client: AsyncClient,
    session_factory: async_sessionmaker[AsyncSession],
    file_storage: InMemoryFileStorage,
    tmp_path: Path,
) -> None:
    # `RunService.create` bakes `Settings.runs_dir` into `Run.work_dir` at
    # creation time - point it at `tmp_path` so the run created over HTTP
    # below lands somewhere `GenerationService` can actually write to,
    # instead of the container-only default `/app/runs`.
    app.dependency_overrides[get_settings] = lambda: _settings(tmp_path)

    project_response = await client.post("/api/v1/projects", json=MINIMAL_PROJECT)
    assert project_response.status_code == 201
    project_id = project_response.json()["id"]

    run_response = await client.post(
        f"/api/v1/projects/{project_id}/runs", json={"outline": "generate"}
    )
    assert run_response.status_code == 202
    run_id = run_response.json()["id"]

    async def drive_generation() -> None:
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
                file_storage=file_storage,
                settings=_settings(tmp_path),
                drain_poll_interval_s=0.05,
            )
            await service.execute(run)

    generation_task = asyncio.create_task(drive_generation())

    seen_stages: list[str] = []
    async with client.stream("GET", f"/api/v1/runs/{run_id}/events/stream") as response:
        assert response.status_code == 200
        async for line in response.aiter_lines():
            if line.startswith("event:"):
                seen_stages.append(line.removeprefix("event:").strip())
            if seen_stages and seen_stages[-1] == "done":
                break

    await asyncio.wait_for(generation_task, timeout=15)

    assert "section" in seen_stages
    assert seen_stages[-1] == "done"
