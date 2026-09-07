"""`RunService` is the API-side surface (create/list/get/cancel/events) that
`api.presentation.routers.runs` calls into. `GenerationService` is the
worker-side counterpart (`api/worker/__main__.py`) that actually prepares a
work directory, drives the CLI subprocess, and persists its outcome - the two
never run in the same process.
"""

from __future__ import annotations

import asyncio
import json
import logging
import queue
import shutil
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from starlette.concurrency import run_in_threadpool

from api.application import graph_import
from api.application.book_spec import SpecRenderer, StructureBuilder
from api.core.errors import Conflict, NotFound
from api.core.settings import Settings
from api.domain.models import File, Project, Run, RunArtifact, RunEvent, RunKind, RunOptions, RunStatus
from api.domain.outline import OutlineTree, build_tree
from api.domain.ports import (
    FileRepository,
    FileStorage,
    OutlineRepository,
    ProjectRepository,
    RunArtifactRepository,
    RunEventRepository,
    RunQueue,
    RunRepository,
    SourceRepository,
)
from api.infrastructure.cli import artifacts, book_command, subprocess_runner

logger = logging.getLogger("api.application.runs")

# How many events the drain loop batches per DB write / how often (seconds)
# it polls for new events, cancellation, and sends a heartbeat while a
# subprocess is running.
_EVENT_BATCH_SIZE = 50
_DRAIN_POLL_INTERVAL_S = 1.0


class RunService:
    def __init__(
        self,
        run_repository: RunRepository,
        run_event_repository: RunEventRepository,
        project_repository: ProjectRepository,
        run_artifact_repository: RunArtifactRepository,
        file_repository: FileRepository,
        settings: Settings,
    ) -> None:
        self._runs = run_repository
        self._events = run_event_repository
        self._projects = project_repository
        self._artifacts = run_artifact_repository
        self._files = file_repository
        self._settings = settings

    async def _get(self, run_id: uuid.UUID) -> Run:
        run = await self._runs.get(run_id)
        if run is None:
            raise NotFound(f"run {run_id} does not exist")
        return run

    async def create(
        self,
        project_id: uuid.UUID,
        *,
        outline: Literal["project", "generate"] = "project",
        output_format: Literal["markdown", "latex", "pdf"] | None = None,
        allow_subdivision: bool = False,
        enable_web_rag: bool = False,
        audit_book: bool = False,
        audit_book_mode: Literal["off", "warn", "strict"] = "warn",
        legacy_tex: bool = False,
        rebuild_kb: bool = False,
        fail_fast_schema: bool = False,
        resume: bool = False,
        export_tex_only: bool = False,
    ) -> Run:
        project = await self._projects.get(project_id)
        if project is None:
            raise NotFound(f"project {project_id} does not exist")
        active = await self._runs.get_active_for_project(project_id)
        if active is not None:
            raise Conflict(
                f"project {project_id} already has an active run ({active.id}, "
                f"status={active.status.value})"
            )

        options = RunOptions(
            outline=outline,
            output_format=output_format or project.output_format.value,
            allow_subdivision=allow_subdivision,
            enable_web_rag=enable_web_rag,
            audit_book=audit_book,
            audit_book_mode=audit_book_mode,
            legacy_tex=legacy_tex,
            rebuild_kb=rebuild_kb,
            fail_fast_schema=fail_fast_schema,
            resume=resume,
            export_tex_only=export_tex_only,
        )

        run_id = uuid.uuid4()
        now = datetime.now(timezone.utc)
        run = Run(
            id=run_id,
            project_id=project_id,
            kind=RunKind.full,
            status=RunStatus.queued,
            options=options,
            base_run_id=None,
            target_node_id=None,
            work_dir=str(Path(self._settings.runs_dir) / str(run_id)),
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
        created = await self._runs.add(run)

        project.last_run_id = created.id
        project.updated_at = now
        await self._projects.update(project)
        return created

    async def get(self, run_id: uuid.UUID) -> Run:
        return await self._get(run_id)

    async def list(
        self, project_id: uuid.UUID, *, limit: int, offset: int
    ) -> tuple[list[Run], int]:
        if await self._projects.get(project_id) is None:
            raise NotFound(f"project {project_id} does not exist")
        return await self._runs.list(project_id, limit, offset)

    async def cancel(self, run_id: uuid.UUID) -> Run:
        run = await self._get(run_id)
        if run.status == RunStatus.queued:
            run.status = RunStatus.cancelled
            run.cancel_requested = True
            run.error = "cancelled before it started"
            run.finished_at = datetime.now(timezone.utc)
            return await self._runs.update(run)
        if run.status == RunStatus.running:
            run.cancel_requested = True
            return await self._runs.update(run)
        raise Conflict(f"run {run_id} is already {run.status.value}")

    async def events(
        self, run_id: uuid.UUID, *, after_seq: int, limit: int
    ) -> tuple[list[RunEvent], int]:
        await self._get(run_id)
        return await self._events.list(run_id, after_seq, limit)

    async def artifacts(
        self, run_id: uuid.UUID, *, limit: int, offset: int
    ) -> tuple[list[tuple[RunArtifact, File]], int]:
        await self._get(run_id)
        artifacts_, total = await self._artifacts.list(run_id, limit, offset)
        pairs: list[tuple[RunArtifact, File]] = []
        for artifact in artifacts_:
            file = await self._files.get(artifact.file_id)
            if file is not None:
                pairs.append((artifact, file))
        return pairs, total


async def sweep_stale_work_dirs(run_repository: RunRepository, retention_days: float) -> int:
    """Delete the work directories of terminal runs older than
    `retention_days` (uploaded artifacts already live in object storage, so
    nothing generated by the run is lost). Called by the worker alongside
    its stale-run requeue sweep. A run whose work directory is gone this way
    still exists in the database - `RunService.get` reports it via
    `resumable: false`."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    stale = await run_repository.list_terminal_before(cutoff)
    removed = 0
    for run in stale:
        work_dir = Path(run.work_dir)
        if work_dir.is_dir():
            await run_in_threadpool(shutil.rmtree, work_dir, True)
            removed += 1
    return removed


def _read_run_meta(work_dir: str) -> dict[str, Any] | None:
    path = Path(work_dir) / book_command.OUT_DIRNAME / "run_meta.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _extract_totals(run_meta: dict[str, Any] | None) -> tuple[int | None, float | None]:
    if not run_meta:
        return None, None
    token_values = [v for v in (run_meta.get("token_totals") or {}).values() if isinstance(v, (int, float))]
    cost_values = [v for v in (run_meta.get("cost_totals_usd") or {}).values() if isinstance(v, (int, float))]
    total_tokens = int(sum(token_values)) if token_values else None
    total_cost = float(sum(cost_values)) if cost_values else None
    return total_tokens, total_cost


class GenerationService:
    """Worker-side execution of one `Run`: prepare its work directory, drive
    the CLI subprocess, and persist the outcome. `execute` never raises for
    an ordinary CLI failure (non-zero exit, missing project) - those become a
    `failed` run - it only propagates truly unexpected errors so the worker
    loop can log them and move on to the next run."""

    def __init__(
        self,
        run_repository: RunRepository,
        run_event_repository: RunEventRepository,
        run_queue: RunQueue,
        project_repository: ProjectRepository,
        outline_repository: OutlineRepository,
        source_repository: SourceRepository,
        file_repository: FileRepository,
        file_storage: FileStorage,
        run_artifact_repository: RunArtifactRepository,
        settings: Settings,
        *,
        drain_poll_interval_s: float = _DRAIN_POLL_INTERVAL_S,
    ) -> None:
        self._runs = run_repository
        self._events = run_event_repository
        self._queue = run_queue
        self._projects = project_repository
        self._outline = outline_repository
        self._sources = source_repository
        self._files = file_repository
        self._storage = file_storage
        self._artifacts = run_artifact_repository
        self._settings = settings
        self._drain_poll_interval_s = drain_poll_interval_s

    async def execute(self, run: Run) -> Run:
        project = await self._projects.get(run.project_id)
        if project is None:
            return await self._fail(run, "project no longer exists")

        try:
            flat_nodes = await self._outline.list(run.project_id)
            outline_tree = build_tree(flat_nodes)
            await self._prepare_work_dir(run, project, outline_tree)
            await self._download_sources(run)
            argv, env, cwd = book_command.build_command(run.work_dir, run.options, self._settings)
            exit_code = await self._run_subprocess_and_drain(run, argv, env, cwd)
        except Exception as exc:  # noqa: BLE001 - any prep/run failure -> failed run
            logger.exception("run %s failed before/while executing the CLI", run.id)
            return await self._fail(run, str(exc), project)

        return await self._finalize(run, exit_code, project)

    async def _prepare_work_dir(
        self, run: Run, project: Project, outline_tree: list[OutlineTree]
    ) -> None:
        work_dir = Path(run.work_dir)
        include_outline = run.options.outline == "project"
        txt = SpecRenderer.render(project, outline_tree, include_outline=include_outline)
        structure = None
        if run.options.outline == "project":
            structure = StructureBuilder.build(
                project, outline_tree, lock_nodes=not run.options.allow_subdivision
            )
        # Local disk writes, kept off the event loop (same reasoning as
        # `_run_subprocess_and_drain`'s `run_in_threadpool` below): with
        # `WORKER_CONCURRENCY > 1` every slot shares one event loop, and a
        # blocking write here would stall every other slot's drain loop
        # (heartbeat, event flushing, cancellation) until it returns.
        await run_in_threadpool(self._write_work_dir_sync, work_dir, txt, structure)

    @staticmethod
    def _write_work_dir_sync(work_dir: Path, txt: str, structure: dict[str, Any] | None) -> None:
        work_dir.mkdir(parents=True, exist_ok=True)
        (work_dir / book_command.INPUT_FILENAME).write_text(txt, encoding="utf-8")
        if structure is not None:
            # A relative `-j` resolves against `out_dir`, not `work_dir`
            # (`autogenbook/pipelines/book_pipeline.py:229-232`), so the
            # pre-rendered structure has to live at
            # `work_dir/out/book_structure.json` - anywhere else and the CLI
            # silently fails to find it and falls back to LLM-structuring
            # the TXT input instead.
            out_dir = work_dir / book_command.OUT_DIRNAME
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / book_command.BOOK_STRUCTURE_FILENAME).write_text(
                json.dumps(structure, ensure_ascii=False, indent=2), encoding="utf-8"
            )

    async def _download_sources(self, run: Run) -> None:
        sources = await self._sources.list_all(run.project_id)
        if not sources:
            return
        kb_dir = Path(run.work_dir) / book_command.KB_DIRNAME
        for source in sources:
            file = await self._files.get(source.file_id)
            if file is None:
                continue
            dest_dir = kb_dir / str(source.id)
            dest = dest_dir / file.filename
            # Buffered in memory, then written in one off-loop call - kb
            # sources are individual documents (PDFs/notes), not large
            # enough to warrant streaming writes at the cost of a
            # threadpool hop per chunk.
            chunks = [chunk async for chunk in await self._storage.open(file.storage_key)]
            await run_in_threadpool(self._write_file_sync, dest_dir, dest, chunks)

    @staticmethod
    def _write_file_sync(dest_dir: Path, dest: Path, chunks: list[bytes]) -> None:
        dest_dir.mkdir(parents=True, exist_ok=True)
        with dest.open("wb") as handle:
            for chunk in chunks:
                handle.write(chunk)

    async def _run_subprocess_and_drain(
        self, run: Run, argv: list[str], env: dict[str, str], cwd: str
    ) -> int:
        event_queue: "queue.Queue[RunEvent]" = queue.Queue()
        cancel_event = threading.Event()
        subprocess_done = threading.Event()

        def on_event(event: RunEvent) -> None:
            event_queue.put(event)

        def should_cancel() -> bool:
            return cancel_event.is_set()

        async def run_subprocess() -> int:
            try:
                return await run_in_threadpool(
                    subprocess_runner.run,
                    argv,
                    env,
                    cwd,
                    run.work_dir,
                    on_event,
                    should_cancel,
                    cancel_grace_s=self._settings.cli_cancel_grace_s,
                    timeout_s=self._settings.cli_run_timeout_s,
                )
            finally:
                subprocess_done.set()

        async def drain_loop() -> None:
            while True:
                batch: list[RunEvent] = []
                try:
                    while len(batch) < _EVENT_BATCH_SIZE:
                        batch.append(event_queue.get_nowait())
                except queue.Empty:
                    pass
                if batch:
                    await self._events.append_batch(run.id, batch)

                current = await self._runs.get(run.id)
                if current is not None and current.cancel_requested:
                    cancel_event.set()
                await self._queue.heartbeat(run.id)

                if subprocess_done.is_set() and event_queue.empty():
                    break
                await asyncio.sleep(self._drain_poll_interval_s)

        exit_code, _ = await asyncio.gather(run_subprocess(), drain_loop())
        return exit_code

    async def _finalize(self, run: Run, exit_code: int, project: Project) -> Run:
        run_meta = _read_run_meta(run.work_dir)
        total_tokens, total_cost = _extract_totals(run_meta)

        current = await self._runs.get(run.id)
        cancel_requested = current.cancel_requested if current is not None else run.cancel_requested

        if cancel_requested and exit_code != 0:
            status = RunStatus.cancelled
            error = "run was cancelled"
        elif exit_code == 0:
            status = RunStatus.succeeded
            error = None
        else:
            status = RunStatus.failed
            error = (run_meta or {}).get("error") or f"CLI exited with code {exit_code}"

        run.status = status
        run.exit_code = exit_code
        run.error = error
        run.cancel_requested = cancel_requested
        run.finished_at = datetime.now(timezone.utc)
        run.total_tokens = total_tokens
        run.total_cost_usd = total_cost

        # Artifacts are uploaded regardless of outcome (whatever the CLI
        # produced before failing is still worth downloading); the outline
        # is only synced back from a run the CLI actually completed.
        await self._upload_artifacts(run, project)
        if status == RunStatus.succeeded:
            await self._import_graph(run, project)

        saved = await self._runs.update(run)
        await self._emit_done(saved)
        return saved

    async def _fail(self, run: Run, message: str, project: Project | None = None) -> Run:
        run.status = RunStatus.failed
        run.error = message
        run.finished_at = datetime.now(timezone.utc)
        await self._upload_artifacts(run, project)
        saved = await self._runs.update(run)
        await self._emit_done(saved)
        return saved

    async def _upload_artifacts(self, run: Run, project: Project | None) -> None:
        out_dir = Path(run.work_dir) / book_command.OUT_DIRNAME
        if not out_dir.is_dir():
            return
        rewrite = project is not None and self._settings.rewrite_author_line
        try:
            await artifacts.upload_artifacts(
                out_dir,
                run.id,
                self._files,
                self._artifacts,
                self._storage,
                authors=project.authors if rewrite else None,
            )
        except Exception:  # noqa: BLE001 - artifact upload is best-effort
            logger.exception("run %s: failed to upload artifacts", run.id)

    async def _import_graph(self, run: Run, project: Project) -> None:
        try:
            await graph_import.import_graph(
                project, Path(run.work_dir), self._outline, self._sources
            )
            project.last_run_id = run.id
            project.updated_at = datetime.now(timezone.utc)
            await self._projects.update(project)
        except Exception:  # noqa: BLE001 - graph sync-back is best-effort
            logger.exception("run %s: failed to import structure_graph.json", run.id)

    async def _emit_done(self, run: Run) -> None:
        next_seq = await self._events.max_seq(run.id) + 1
        await self._events.append_batch(
            run.id,
            [
                RunEvent(
                    seq=next_seq,
                    ts=datetime.now(timezone.utc),
                    level="error" if run.status == RunStatus.failed else "info",
                    stage="done",
                    message=f"Run {run.status.value}",
                    payload={
                        "status": run.status.value,
                        "exitCode": run.exit_code,
                        "error": run.error,
                    },
                )
            ],
        )
