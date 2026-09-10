from __future__ import annotations

import asyncio
import io
import json
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.application.runs import _DRAIN_MAX_CONSECUTIVE_FAILURES, GenerationService
from api.core.errors import StorageError
from api.core.settings import Settings
from api.domain.models import (
    ArtifactKind,
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
from api.infrastructure.cli import book_command
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
        llm_model="openai/gpt-5-mini",
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


async def test_execute_uploads_section_artifact_before_run_finishes(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path, monkeypatch
) -> None:
    """Issue #129: a leaf section's `sections/<key>.md` should already be a
    downloadable `run_artifacts` row while the run is still `running`, not
    only once it reaches a terminal state - the whole point of uploading it
    from the drain loop the moment its `"section"` event lands, instead of
    waiting for `_finalize`'s terminal `upload_artifacts` call."""
    monkeypatch.setenv("FAKE_CLI_STEP_SLEEP_S", "1.0")
    monkeypatch.setattr(
        book_command, "ENV_ALLOWLIST", book_command.ENV_ALLOWLIST + ("FAKE_CLI_STEP_SLEEP_S",)
    )

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

    deadline = time.monotonic() + 15
    seen_while_running = False
    while time.monotonic() < deadline and not task.done():
        async with session_factory() as poll_session:
            current = await SqlAlchemyRunRepository(poll_session).get(run.id)
            rows, _ = await SqlAlchemyRunArtifactRepository(poll_session).list(
                run.id, limit=100, offset=0
            )
        if (
            current is not None
            and current.status == RunStatus.running
            and any(a.kind == ArtifactKind.section for a in rows)
        ):
            seen_while_running = True
            break
        await asyncio.sleep(0.05)

    finished = await asyncio.wait_for(task, timeout=15)

    assert seen_while_running, "no section artifact appeared while the run was still running"
    assert finished.status == RunStatus.succeeded


async def test_execute_does_not_duplicate_artifacts_between_incremental_and_terminal_upload(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    """The section artifacts uploaded incrementally as the CLI produced them
    must not be re-inserted (as a duplicate row) by the terminal `upload_
    artifacts` call `_finalize` makes once the run succeeds (issue #129)."""
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        run = await SqlAlchemyRunRepository(session).add(
            _make_run(project.id, tmp_path / "run")
        )
        service = _make_service(session, InMemoryFileStorage(), _settings())

        finished = await service.execute(run)

        rows, total = await SqlAlchemyRunArtifactRepository(session).list(
            run.id, limit=1000, offset=0
        )

    assert finished.status == RunStatus.succeeded
    relative_paths = [artifact.relative_path for artifact in rows]
    assert len(relative_paths) == len(set(relative_paths)) == total
    assert any(path.startswith("sections/") for path in relative_paths)


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


class _LeakyStorage(InMemoryFileStorage):
    """A `FileStorage` fake whose `open()` fails the way a real MinIO/S3
    connection failure would - a `botocore.exceptions.EndpointConnectionError`
    (a `StorageError` here, matching `S3FileStorage.open`'s own mapping)
    whose message embeds the object-store endpoint URL and key."""

    async def open(self, key: str):
        raise StorageError(
            f'Could not connect to the endpoint URL: "http://minio:9000/autogenbook/{key}"'
        )


async def test_execute_sanitizes_a_leaky_storage_failure_in_run_error(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    """Regression for issue #82: a raw boto3/`StorageError` message (or an
    `OSError` naming an absolute path) used to land verbatim in `run.error`
    - exposing the object store's internal endpoint URL and bucket/key to
    API clients - instead of a short, generic message."""
    storage = _LeakyStorage()

    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())

        file = File(
            id=uuid.uuid4(),
            storage_key="uploads/notes.md",
            filename="notes.md",
            content_type="text/markdown",
            size_bytes=10,
            sha256="0" * 64,
            kind=FileKind.upload,
            kb_eligible=True,
        )
        await SqlAlchemyFileRepository(session).add(file)

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
        service = _make_service(session, storage, _settings())

        finished = await service.execute(run)

    assert finished.status == RunStatus.failed
    assert finished.error is not None
    assert "minio" not in finished.error
    assert "http://" not in finished.error
    assert "uploads/notes.md" not in finished.error


async def test_write_source_sync_streams_chunks_incrementally(tmp_path: Path) -> None:
    """Regression for issue #55: `_download_sources` used to buffer a whole
    source fully (`[chunk async for chunk in ...]`) in memory before ever
    writing a byte. `_write_source_sync` should instead write each chunk to
    disk as it arrives - observable here as the destination file's size
    growing in steps rather than jumping straight from 0 to its final size
    once the whole thing has already been assembled in memory."""
    from types import SimpleNamespace

    chunks = [b"a" * 1000, b"b" * 1000, b"c" * 1000]
    full_content = b"".join(chunks)

    class _SlowChunkStorage:
        async def open(self, key: str):
            async def gen():
                for chunk in chunks:
                    await asyncio.sleep(0.05)
                    yield chunk

            return gen()

    dest_dir = tmp_path / "kb" / "source-1"
    dest = dest_dir / "file.bin"
    fake_service = SimpleNamespace(_storage=_SlowChunkStorage())

    write_task = asyncio.create_task(
        GenerationService._write_source_sync(fake_service, dest_dir, dest, "irrelevant-key")
    )

    observed_sizes: set[int] = set()
    while not write_task.done():
        if dest.exists():
            observed_sizes.add(dest.stat().st_size)
        await asyncio.sleep(0.01)
    await write_task

    assert dest.read_bytes() == full_content
    # A partial size (neither 0 nor the final length) proves the file grew
    # incrementally as chunks arrived, rather than only becoming visible
    # once everything had already been buffered and written in one shot.
    assert any(0 < size < len(full_content) for size in observed_sizes), observed_sizes


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


async def test_finalize_ignores_stale_run_meta_left_by_a_shared_work_dir(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    """issue #81: a `regenerate_section`/`export` run reuses its base run's
    `work_dir` verbatim. If *this* run's own CLI subprocess never gets to
    (re)write `run_meta.json` - killed by cancellation or a timeout before
    reaching the `finally` that writes it - `_finalize` used to read
    whatever `run_meta.json` was already sitting in that shared directory
    (the base run's own, from a run that finished over an hour before this
    attempt even started), double-counting its cost/tokens onto this run and
    misattributing its error string on a failed exit."""
    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        work_dir = tmp_path / "shared-run"
        out_dir = work_dir / "out"
        out_dir.mkdir(parents=True)
        stale_finished_at = datetime.now(timezone.utc) - timedelta(hours=1)
        (out_dir / "run_meta.json").write_text(
            json.dumps(
                {
                    "run_id": "20260101T000000Z",
                    "finished_at": stale_finished_at.isoformat(),
                    "token_totals": {"writer": 12345},
                    "cost_totals_usd": {"writer": 6.78},
                    "error": "the base run's own failure message",
                }
            ),
            encoding="utf-8",
        )

        run = await SqlAlchemyRunRepository(session).add(
            _make_run(
                project.id,
                work_dir,
                kind=RunKind.regenerate_section,
                started_at=datetime.now(timezone.utc),
                cancel_requested=False,
            )
        )
        service = _make_service(session, InMemoryFileStorage(), _settings())

        finished = await service._finalize(run, exit_code=1, project=project)

    assert finished.status == RunStatus.failed
    assert finished.total_tokens is None
    assert finished.total_cost_usd is None
    assert finished.error == "CLI exited with code 1"


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
    # Slow the fake CLI down so there is a real mid-run window to cancel in.
    # The value only reaches the child if it is on `ENV_ALLOWLIST` (issue
    # #129's incremental uploads exposed that this test used to race the
    # default 0.05s/step CLI instead).
    monkeypatch.setenv("FAKE_CLI_STEP_SLEEP_S", "1.0")
    monkeypatch.setattr(
        book_command, "ENV_ALLOWLIST", book_command.ENV_ALLOWLIST + ("FAKE_CLI_STEP_SLEEP_S",)
    )

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


async def test_execute_releases_run_for_resume_on_worker_shutdown(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path, monkeypatch
) -> None:
    """Regression for issue #52: on SIGTERM, the worker used to await
    `execute()` to completion (potentially the CLI's full multi-hour
    timeout) before ever noticing shutdown was requested - compose's
    `stop_grace_period` then SIGKILLs the container, leaving the run stuck
    `running` until `WORKER_STALE_S` elapses and `requeue_stale` reclaims
    it, re-executing a `full` run from scratch. A `shutdown_event` passed
    to `execute` should instead have it tear the CLI subprocess down
    promptly and hand the run back to `queued` right away - with `resume`
    flipped on, since the fake CLI has already written `structure_graph.
    json` by the time its (artificially long) per-step sleep is hit."""
    monkeypatch.setenv("FAKE_CLI_STEP_SLEEP_S", "5.0")
    monkeypatch.setattr(
        book_command, "ENV_ALLOWLIST", book_command.ENV_ALLOWLIST + ("FAKE_CLI_STEP_SLEEP_S",)
    )

    async with session_factory() as setup_session:
        project = await SqlAlchemyProjectRepository(setup_session).add(_make_project())
        run = await SqlAlchemyRunRepository(setup_session).add(
            _make_run(project.id, tmp_path / "run")
        )

    shutdown_event = asyncio.Event()

    async def run_service() -> Run:
        async with session_factory() as service_session:
            service = _make_service(
                service_session, InMemoryFileStorage(), _settings(), worker_id="worker-1"
            )
            return await service.execute(run, shutdown_event=shutdown_event)

    task = asyncio.create_task(run_service())

    deadline = time.monotonic() + 10
    graph_path = tmp_path / "run" / "out" / "structure_graph.json"
    while time.monotonic() < deadline and not graph_path.is_file():
        await asyncio.sleep(0.05)
    assert graph_path.is_file(), "fake CLI never wrote structure_graph.json before deadline"

    shutdown_event.set()

    finished = await asyncio.wait_for(task, timeout=15)

    assert finished.status == RunStatus.queued
    assert finished.locked_by is None
    assert finished.started_at is None
    assert finished.options.resume is True


async def test_execute_reports_clear_error_when_killed_by_cli_run_timeout(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path, monkeypatch
) -> None:
    """Regression for issue #80: a run killed by the API's own
    `CLI_RUN_TIMEOUT_S` deadline used to be reported with the same opaque
    `"CLI exited with code -9"` message as a genuine CLI crash, even though
    it may have produced perfectly usable, resumable output sitting in the
    work dir. The error message should make that distinction visible."""
    monkeypatch.setenv("FAKE_CLI_STEP_SLEEP_S", "5.0")
    monkeypatch.setattr(
        book_command,
        "ENV_ALLOWLIST",
        book_command.ENV_ALLOWLIST + ("FAKE_CLI_STEP_SLEEP_S",),
    )

    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        run = await SqlAlchemyRunRepository(session).add(
            _make_run(project.id, tmp_path / "run")
        )
        settings = _settings(cli_run_timeout_s=0.5, cli_cancel_grace_s=1.0)
        service = _make_service(session, InMemoryFileStorage(), settings)

        finished = await service.execute(run)

    assert finished.status == RunStatus.failed
    assert finished.error == "killed by API after 0.5s timeout"


async def test_drain_loop_failure_kills_orphaned_subprocess_instead_of_leaving_it_running(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path, monkeypatch
) -> None:
    """Regression for issue #48: `_run_subprocess_and_drain` used to `await
    asyncio.gather(run_subprocess(), drain_loop())` with no
    `return_exceptions=True`, so a drain-loop exception (a transient DB
    error in `append_batch`/`_runs.get`/`queue.heartbeat`) propagated
    immediately and left the fake CLI subprocess running, unkilled, while
    the run was already reported `failed`. Simulating a persistently
    failing `RunRepository.get` (one of the drain loop's own per-iteration
    calls, called unconditionally every iteration) should instead exhaust
    the drain loop's bounded retry budget, set `cancel_event`, and tear the
    still-running fake CLI down well before it would ever finish on its
    own."""
    # ENV_ALLOWLIST doesn't forward FAKE_CLI_STEP_SLEEP_S to the child by
    # default (it's test-only plumbing) - extend it for this test so the
    # fake CLI's steps are slow enough that an orphaned child would still
    # be running long after this test's assertion deadline.
    monkeypatch.setenv("FAKE_CLI_STEP_SLEEP_S", "5.0")
    monkeypatch.setattr(
        book_command,
        "ENV_ALLOWLIST",
        book_command.ENV_ALLOWLIST + ("FAKE_CLI_STEP_SLEEP_S",),
    )

    class _FlakyRunRepository:
        """Proxies every `RunRepository` call to `inner` except `get`, which
        raises for the first `fail_first_n` calls before recovering - a
        transient DB blip (Postgres restart, connection reset, ...), not a
        permanent outage, exactly as issue #48 describes."""

        def __init__(self, inner, fail_first_n: int) -> None:
            self._inner = inner
            self._fail_first_n = fail_first_n
            self._get_calls = 0

        async def get(self, run_id):
            self._get_calls += 1
            if self._get_calls <= self._fail_first_n:
                raise RuntimeError("simulated transient DB failure")
            return await self._inner.get(run_id)

        def __getattr__(self, name):
            return getattr(self._inner, name)

    async with session_factory() as session:
        project = await SqlAlchemyProjectRepository(session).add(_make_project())
        run = await SqlAlchemyRunRepository(session).add(
            _make_run(project.id, tmp_path / "run")
        )
        flaky_runs = _FlakyRunRepository(
            SqlAlchemyRunRepository(session),
            fail_first_n=_DRAIN_MAX_CONSECUTIVE_FAILURES + 1,
        )
        service = GenerationService(
            run_repository=flaky_runs,
            run_event_repository=SqlAlchemyRunEventRepository(session),
            run_queue=SqlAlchemyRunQueue(session),
            project_repository=SqlAlchemyProjectRepository(session),
            outline_repository=SqlAlchemyOutlineRepository(session),
            source_repository=SqlAlchemySourceRepository(session),
            file_repository=SqlAlchemyFileRepository(session),
            file_storage=InMemoryFileStorage(),
            run_artifact_repository=SqlAlchemyRunArtifactRepository(session),
            settings=_settings(),
            drain_poll_interval_s=0.05,
        )

        started = time.monotonic()
        finished = await service.execute(run)
        elapsed = time.monotonic() - started

    assert finished.status == RunStatus.failed
    assert finished.error is not None
    assert "simulated transient DB failure" in finished.error
    # With FAKE_CLI_STEP_SLEEP_S=5.0 and multiple steps (JSON/structure,
    # two leaf sections, Markdown assembly), an orphaned fake CLI would
    # still be running many seconds from now - torn down promptly instead,
    # this returns quickly.
    assert elapsed < 10
