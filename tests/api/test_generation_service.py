from __future__ import annotations

import asyncio
import io
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.application.runs import GenerationService
from api.core.settings import Settings
from api.domain.models import (
    File,
    FileKind,
    OutputFormat,
    Project,
    Run,
    RunEvent,
    RunKind,
    RunOptions,
    RunStatus,
    Source,
    SourceStatus,
    SourceType,
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


def _settings(**overrides) -> Settings:
    defaults = dict(
        cli_python=sys.executable,
        cli_entrypoint=str(FAKE_CLI),
        repo_root=str(REPO_ROOT),
        cli_cancel_grace_s=1.0,
        cli_run_timeout_s=30.0,
    )
    defaults.update(overrides)
    return Settings(**defaults)


def _make_project(**overrides) -> Project:
    now = datetime.now(timezone.utc)
    defaults = dict(
        id=uuid.uuid4(),
        owner_id=None,
        title="AI in Teaching",
        subtitle="A practical guide",
        authors=["Ada Lovelace"],
        topic="using AI tools in university courses",
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


def _make_run(project_id: uuid.UUID, work_dir: Path, **overrides) -> Run:
    now = datetime.now(timezone.utc)
    defaults = dict(
        id=uuid.uuid4(),
        project_id=project_id,
        kind=RunKind.full,
        status=RunStatus.running,
        options=RunOptions(outline="generate", output_format="markdown"),
        base_run_id=None,
        target_node_id=None,
        target_node_previous_status=None,
        work_dir=str(work_dir),
        exit_code=None,
        error=None,
        cancel_requested=False,
        locked_by="worker-1",
        heartbeat_at=now,
        queued_at=now,
        started_at=now,
        finished_at=None,
        total_tokens=None,
        total_cost_usd=None,
    )
    defaults.update(overrides)
    return Run(**defaults)


def _make_service(session: AsyncSession, storage: InMemoryFileStorage, settings: Settings, **kwargs) -> GenerationService:
    return GenerationService(
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
        **kwargs,
    )


async def test_execute_succeeds_with_fake_cli_and_persists_events(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        run = await SqlAlchemyRunRepository(session).add(
            _make_run(project.id, tmp_path / "run")
        )
        service = _make_service(session, InMemoryFileStorage(), _settings())

        finished = await service.execute(run)

        events, total = await SqlAlchemyRunEventRepository(session).list(run.id, 0, 1000)

    assert finished.status == RunStatus.succeeded
    assert finished.exit_code == 0
    assert finished.error is None
    assert finished.finished_at is not None

    assert total == len(events)
    assert len(events) > 0
    seqs = [event.seq for event in events]
    assert seqs == sorted(seqs)
    assert any(event.stage == "section" for event in events)
    assert events[-1].stage == "done"
    assert events[-1].payload["status"] == "succeeded"

    assert (tmp_path / "run" / "out" / "structure_graph.json").exists()


async def test_execute_downloads_sources_into_kb_dir(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    storage = InMemoryFileStorage()
    content = b"# Notes\n\nSome reference material.\n"

    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())

        file = File(
            id=uuid.uuid4(),
            storage_key="uploads/notes.md",
            filename="notes.md",
            content_type="text/markdown",
            size_bytes=len(content),
            sha256="0" * 64,
            kind=FileKind.upload,
            kb_eligible=True,
        )
        await SqlAlchemyFileRepository(session).add(file)
        await storage.put("uploads/notes.md", io.BytesIO(content), "text/markdown")

        source = Source(
            id=uuid.uuid4(),
            project_id=project.id,
            file_id=file.id,
            source_type=SourceType.md,
            authors=None,
            year=None,
            doi=None,
            url=None,
            description=None,
            chunks_count=None,
            status=SourceStatus.ready,
            created_at=datetime.now(timezone.utc),
            deleted_at=None,
        )
        source = await SqlAlchemySourceRepository(session).add(source)

        run = await SqlAlchemyRunRepository(session).add(
            _make_run(project.id, tmp_path / "run")
        )
        service = _make_service(session, storage, _settings())

        finished = await service.execute(run)

    assert finished.status == RunStatus.succeeded
    downloaded = tmp_path / "run" / "kb" / str(source.id) / "notes.md"
    assert downloaded.read_bytes() == content


async def test_execute_marks_failed_when_a_source_file_is_missing_from_storage(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())

        file = File(
            id=uuid.uuid4(),
            storage_key="uploads/missing.md",
            filename="missing.md",
            content_type="text/markdown",
            size_bytes=10,
            sha256="0" * 64,
            kind=FileKind.upload,
            kb_eligible=True,
        )
        await SqlAlchemyFileRepository(session).add(file)
        # Deliberately never `storage.put(...)` this key.

        source = Source(
            id=uuid.uuid4(),
            project_id=project.id,
            file_id=file.id,
            source_type=SourceType.md,
            authors=None,
            year=None,
            doi=None,
            url=None,
            description=None,
            chunks_count=None,
            status=SourceStatus.ready,
            created_at=datetime.now(timezone.utc),
            deleted_at=None,
        )
        await SqlAlchemySourceRepository(session).add(source)

        run = await SqlAlchemyRunRepository(session).add(
            _make_run(project.id, tmp_path / "run")
        )
        service = _make_service(session, InMemoryFileStorage(), _settings())

        finished = await service.execute(run)
        events, _ = await SqlAlchemyRunEventRepository(session).list(run.id, 0, 1000)

    assert finished.status == RunStatus.failed
    assert finished.error is not None
    assert events[-1].stage == "done"
    assert events[-1].payload["status"] == "failed"


async def test_execute_marks_failed_on_nonzero_cli_exit(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        run = await SqlAlchemyRunRepository(session).add(
            _make_run(project.id, tmp_path / "run")
        )
        # Points at a script that doesn't exist: python exits 2 with
        # "can't open file", exercising the exit_code != 0 path distinctly
        # from an exception raised during prep.
        settings = _settings(cli_entrypoint=str(tmp_path / "does_not_exist.py"))
        service = _make_service(session, InMemoryFileStorage(), settings)

        finished = await service.execute(run)

    assert finished.status == RunStatus.failed
    assert finished.exit_code != 0
    assert finished.error is not None


async def test_execute_on_a_reclaimed_run_does_not_collide_on_seq_or_hang(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    """Regression for issue #73: a run requeued after a worker crash (or a
    session poisoned by a previous attempt) is re-executed against the same
    `run.id`, whose `run_events` table already has rows from that earlier,
    interrupted attempt. Before this fix, `subprocess_runner.run` always
    numbered its own events from `seq=1`, so the first `append_batch` of
    the retry violated `uq_run_events_run_id_seq`, poisoned the session,
    and `_fail`'s own `update()` then raised `PendingRollbackError` -
    propagating out of `execute` uncaught and leaving the run stuck
    `running` forever (see `_claim_and_execute`, which only logs and moves
    on)."""
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        run = await SqlAlchemyRunRepository(session).add(
            _make_run(project.id, tmp_path / "run")
        )
        # Simulate events already committed by an earlier, interrupted
        # attempt at this same run.
        await SqlAlchemyRunEventRepository(session).append_batch(
            run.id,
            [
                RunEvent(
                    seq=1,
                    ts=datetime.now(timezone.utc),
                    level="info",
                    stage="log",
                    message="a previous attempt's event",
                )
            ],
        )
        service = _make_service(session, InMemoryFileStorage(), _settings())

        finished = await service.execute(run)

        events, _ = await SqlAlchemyRunEventRepository(session).list(run.id, 0, 1000)

    assert finished.status in (RunStatus.succeeded, RunStatus.failed)
    assert finished.finished_at is not None
    seqs = [event.seq for event in events]
    assert seqs == sorted(seqs)
    assert len(seqs) == len(set(seqs)), "duplicate seq: retry collided with the earlier attempt"
    assert events[-1].stage == "done"


async def test_execute_marks_cancelled_when_cancel_requested_mid_run(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("FAKE_CLI_STEP_SLEEP_S", "1.0")

    # Two independent sessions, mirroring production: the worker's
    # `GenerationService` holds its own session for the run's whole
    # lifetime, while `RunService.cancel` (here, the test standing in for
    # it) writes `cancel_requested` through a separate, short-lived one.
    # `AsyncSession` isn't safe for concurrent use from two coroutines, so
    # the two must never share a session.
    async with session_factory() as setup_session:
        project = await SqlAlchemyProjectRepository(setup_session).add(_make_project())
        run = await SqlAlchemyRunRepository(setup_session).add(
            _make_run(project.id, tmp_path / "run")
        )

    async def run_service() -> Run:
        async with session_factory() as service_session:
            service = _make_service(service_session, InMemoryFileStorage(), _settings())
            return await service.execute(run)

    task = asyncio.create_task(run_service())

    # Wait until the run has actually started producing events, then
    # request cancellation the same way `RunService.cancel` would.
    deadline = time.monotonic() + 10
    events: list = []
    while time.monotonic() < deadline:
        async with session_factory() as poll_session:
            events, _ = await SqlAlchemyRunEventRepository(poll_session).list(run.id, 0, 10)
        if events:
            break
        await asyncio.sleep(0.05)
    assert events, "fake CLI never produced any output before deadline"

    async with session_factory() as cancel_session:
        run_repo = SqlAlchemyRunRepository(cancel_session)
        current = await run_repo.get(run.id)
        assert current is not None
        current.cancel_requested = True
        await run_repo.update(current)

    finished = await asyncio.wait_for(task, timeout=15)

    assert finished.status == RunStatus.cancelled
    assert finished.exit_code != 0
