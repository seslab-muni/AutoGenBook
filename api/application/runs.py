"""`RunService` is the API-side surface (create/list/get/cancel/events) that
`api.presentation.routers.runs` calls into. `GenerationService` is the
worker-side counterpart (`api/worker/__main__.py`) that actually prepares a
work directory, drives the CLI subprocess, and persists its outcome - the two
never run in the same process.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import queue
import shutil
import threading
import uuid
from dataclasses import replace as dataclass_replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from starlette.concurrency import run_in_threadpool

from api.application import graph_import
from api.application.book_spec import SpecRenderer, StructureBuilder
from api.core.errors import Conflict, NotFound, ValidationFailed
from api.core.settings import Settings
from api.domain.models import (
    File,
    NodeStatus,
    Project,
    Run,
    RunArtifact,
    RunEvent,
    RunKind,
    RunOptions,
    RunStatus,
)
from api.domain.outline import OutlineTree, assign_positions, build_tree
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

# A drain-loop iteration can fail on a transient DB error (a Postgres
# restart, a connection reset, ...) - retry a bounded number of times with a
# linear backoff before giving up and tearing down the still-running CLI
# subprocess (issue #48), rather than dying on the very first hiccup.
_DRAIN_MAX_CONSECUTIVE_FAILURES = 5


class RunService:
    def __init__(
        self,
        run_repository: RunRepository,
        run_event_repository: RunEventRepository,
        project_repository: ProjectRepository,
        run_artifact_repository: RunArtifactRepository,
        file_repository: FileRepository,
        outline_repository: OutlineRepository,
        settings: Settings,
    ) -> None:
        self._runs = run_repository
        self._events = run_event_repository
        self._projects = project_repository
        self._artifacts = run_artifact_repository
        self._files = file_repository
        self._outline = outline_repository
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

        resolved_output_format = output_format or project.output_format.value
        # Both combinations "succeed" with no useful output instead of
        # erroring (issue #79): `legacyTex` makes `book_command.build_command`
        # emit `--legacy-tex --export-tex --no-pdf`
        # (`content_format="latex"`, so `md_first=False` in
        # `book_pipeline.py`), but Markdown assembly requires `md_first` and
        # TeX assembly's own `content_format == "markdown"` branch never
        # runs - nothing gets assembled. `auditBook`'s audit
        # (`book_pipeline.py`'s `audit_latex`) needs a `tex_path`, which a
        # markdown-only run never produces, so the option is silently a
        # no-op there too.
        if legacy_tex and resolved_output_format == "markdown":
            raise ValidationFailed(
                "legacyTex is only valid with outputFormat 'latex' or 'pdf', not 'markdown'"
            )
        if audit_book and resolved_output_format == "markdown":
            raise ValidationFailed(
                "auditBook has no effect with outputFormat 'markdown' (the audit runs "
                "against the LaTeX build, which a markdown-only run never produces)"
            )

        options = RunOptions(
            outline=outline,
            output_format=resolved_output_format,
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
            target_node_previous_status=None,
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

        # `last_run_id` is deliberately *not* set to this just-queued run
        # here (issue #66): `_resolvable_base_run` (regenerate/export) treats
        # it as "the base to resume from", so eagerly pointing it at a run
        # that hasn't succeeded yet meant one failed/cancelled/still-queued
        # full run permanently blocked regenerate/export until another full
        # run succeeded - even though the *previous* succeeded run's work
        # dir was still on disk and perfectly resumable. Only
        # `GenerationService._import_graph`/`_import_target_node` (worker
        # side, on an actually succeeded run) advance it now. The
        # `updated_at` bump is left as-is - queueing a run is still activity
        # worth reordering the project hub list by.
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
            saved = await self._runs.update(run)
            # The worker's own `_finalize`/`_fail` never run for a queued
            # run cancelled before it was even claimed - without a "done"
            # event, `GET /runs/{id}/events/stream` polled forever (issue
            # #63), and a `regenerate_section` target node stayed at
            # `drafting` forever. Do here what the worker would have done.
            if (
                saved.target_node_id is not None
                and saved.target_node_previous_status is not None
            ):
                node = await self._outline.get(saved.target_node_id)
                if node is not None:
                    await self._outline.update(
                        dataclass_replace(
                            node,
                            status=saved.target_node_previous_status,
                            updated_at=datetime.now(timezone.utc),
                        )
                    )
            next_seq = await self._events.max_seq(run_id) + 1
            await self._events.append_batch(run_id, [build_done_event(saved, next_seq)])
            return saved
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

    async def _resolvable_base_run(self, project_id: uuid.UUID, base_run_id: uuid.UUID | None) -> Run:
        """The most recent `full`/`regenerate_section` run whose work
        directory a `regenerate_section` run can resume from - `409` with
        guidance to start a full run for every way that isn't possible."""
        if base_run_id is None:
            raise Conflict(
                f"project {project_id} has no previous run; start a full run first"
            )
        base_run = await self._runs.get(base_run_id)
        if (
            base_run is None
            or base_run.kind not in (RunKind.full, RunKind.regenerate_section)
            or base_run.status != RunStatus.succeeded
        ):
            raise Conflict(
                f"project {project_id}'s last run is not a succeeded full/regenerate_section "
                "run; start a full run first"
            )
        if not Path(base_run.work_dir).is_dir():
            raise Conflict(
                f"run {base_run.id}'s work directory no longer exists; start a full run first"
            )
        return base_run

    async def regenerate_node(
        self,
        project_id: uuid.UUID,
        node_id: uuid.UUID,
        *,
        prompt_modifier: str | None = None,
    ) -> Run:
        project = await self._projects.get(project_id)
        if project is None:
            raise NotFound(f"project {project_id} does not exist")

        flat = await self._outline.list(project_id)
        positioned = {node.id: node for node in assign_positions(flat)}
        node = positioned.get(node_id)
        if node is None:
            raise NotFound(f"outline node {node_id} does not exist")
        if not node.cli_key:
            raise Conflict(f"outline node {node_id} has no cli_key; start a full run first")
        if any(n.parent_id == node_id for n in flat):
            # The CLI only ever writes `sections/<key>.md` for leaves
            # (`book_builder.py:generate_contents`) - a parent node has no
            # section file to delete, so `--resume` regenerates nothing,
            # the run still reports `succeeded`, and the node was left
            # stuck at `drafting` forever (issue #77).
            raise Conflict(
                f"outline node {node_id} has child sections; regenerate only "
                "applies to leaf nodes"
            )

        active = await self._runs.get_active_for_project(project_id)
        if active is not None:
            raise Conflict(
                f"project {project_id} already has an active run ({active.id}, "
                f"status={active.status.value})"
            )

        base_run = await self._resolvable_base_run(project_id, project.last_run_id)

        # A structural edit (new/removed/moved node, retitled project, ...)
        # since `base_run` would make its frozen `structure_graph.json`
        # inconsistent with the current outline - `--resume` never re-runs
        # `subdivide_graph`, so the only safe path forward there is a new
        # `full` run. Re-rendering the current project/outline into the same
        # TXT `_prepare_work_dir` would have produced and comparing its
        # hash to what the base run actually saw catches that drift here,
        # synchronously, instead of only failing once the worker gets to it.
        outline_tree = build_tree(flat)
        include_outline = base_run.options.outline == "project"
        current_txt = SpecRenderer.render(project, outline_tree, include_outline=include_outline)
        current_sha256 = hashlib.sha256(current_txt.encode("utf-8")).hexdigest()
        stored_sha256 = _read_graph_input_sha256(base_run.work_dir)
        if stored_sha256 and stored_sha256 != current_sha256:
            raise Conflict(
                "the outline has changed since the base run; start a full run"
            )

        now = datetime.now(timezone.utc)
        options = dataclass_replace(
            base_run.options,
            resume=True,
            outline=base_run.options.outline,
            prompt_modifier=prompt_modifier,
        )
        run = Run(
            id=uuid.uuid4(),
            project_id=project_id,
            kind=RunKind.regenerate_section,
            status=RunStatus.queued,
            options=options,
            base_run_id=base_run.id,
            target_node_id=node_id,
            target_node_previous_status=node.status,
            work_dir=base_run.work_dir,
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
        await self._outline.update(
            dataclass_replace(node, status=NodeStatus.DRAFTING, updated_at=now)
        )
        return created

    async def export(
        self,
        run_id: uuid.UUID,
        *,
        output_format: Literal["latex", "pdf"],
    ) -> Run:
        base_run = await self._get(run_id)
        if base_run.status != RunStatus.succeeded:
            raise Conflict(f"run {run_id} did not succeed; cannot export from it")
        if not Path(base_run.work_dir).is_dir():
            raise Conflict(
                f"run {run_id}'s work directory no longer exists; start a full run first"
            )

        active = await self._runs.get_active_for_project(base_run.project_id)
        if active is not None:
            raise Conflict(
                f"project {base_run.project_id} already has an active run ({active.id}, "
                f"status={active.status.value})"
            )

        now = datetime.now(timezone.utc)
        options = dataclass_replace(
            base_run.options,
            resume=True,
            export_tex_only=True,
            output_format=output_format,
            prompt_modifier=None,
        )
        run = Run(
            id=uuid.uuid4(),
            project_id=base_run.project_id,
            kind=RunKind.export,
            status=RunStatus.queued,
            options=options,
            base_run_id=base_run.id,
            target_node_id=None,
            target_node_previous_status=None,
            work_dir=base_run.work_dir,
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
        return await self._runs.add(run)


def build_done_event(run: Run, seq: int) -> RunEvent:
    """The terminal SSE event both `GenerationService._emit_done` (a run
    the worker actually finished) and `RunService.cancel` (a `queued` run
    cancelled before the worker ever claimed it, see issue #63) append so
    `GET /runs/{id}/events/stream` has something to terminate on."""
    return RunEvent(
        seq=seq,
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


def _read_graph_input_sha256(work_dir: str) -> str | None:
    path = Path(work_dir) / book_command.OUT_DIRNAME / "structure_graph.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    value = str((data.get("graph") or {}).get("input_sha256") or "").strip()
    return value or None


async def sweep_stale_work_dirs(run_repository: RunRepository, retention_days: float) -> int:
    """Delete the work directories of runs idle for `retention_days`
    (uploaded artifacts already live in object storage, so nothing
    generated by the run is lost). Called by the worker alongside its
    stale-run requeue sweep. A run whose work directory is gone this way
    still exists in the database - `RunService.get` reports it via
    `resumable: false`.

    A `regenerate_section`/`export` run reuses its base run's `work_dir`
    verbatim, so this only ever deletes a directory once every run sharing
    it (base plus any regenerate/export built on it) is terminal and none
    of them finished after the cutoff - see `RunRepository.
    list_stale_work_dirs` (issue #64: this used to sweep per terminal *run*,
    which could `rmtree` a directory a still-running or newer sibling run
    was relying on)."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    stale_work_dirs = await run_repository.list_stale_work_dirs(cutoff)
    removed = 0
    for work_dir_str in stale_work_dirs:
        work_dir = Path(work_dir_str)
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
            if run.kind == RunKind.full:
                flat_nodes = await self._outline.list(run.project_id)
                outline_tree = build_tree(flat_nodes)
                await self._prepare_work_dir(run, project, outline_tree)
                await self._download_sources(run)
            elif run.kind == RunKind.regenerate_section:
                await self._prepare_regenerate(run)
            elif run.kind == RunKind.export:
                await self._prepare_export(run)
            else:  # pragma: no cover - exhaustive over RunKind
                raise ValueError(f"unknown run kind: {run.kind!r}")
            argv, env, cwd = book_command.build_command(
                run.work_dir, run.options, self._settings, author=", ".join(project.authors)
            )
            exit_code, timed_out = await self._run_subprocess_and_drain(run, argv, env, cwd)
            return await self._finalize(run, exit_code, project, timed_out=timed_out)
        except Exception as exc:  # noqa: BLE001 - any prep/run/finalize failure -> failed run
            logger.exception("run %s failed before/while executing the CLI", run.id)
            # A failed commit (e.g. `append_batch` hitting a duplicate
            # `seq` on a re-claimed run, see `_run_subprocess_and_drain`'s
            # `start_seq`) leaves the shared session in SQLAlchemy's
            # "pending rollback" state; every subsequent statement on it -
            # including `_fail`'s own `update()` - would raise
            # `PendingRollbackError` and leave the run stuck `running`
            # forever, getting re-claimed and re-executed (new CLI, new
            # LLM spend) every `WORKER_STALE_S`. Roll back first so `_fail`
            # can actually persist a terminal status.
            await self._runs.rollback()
            return await self._fail(run, str(exc), project)

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

    async def _prepare_regenerate(self, run: Run) -> None:
        """`regenerate_section`: reuse the base run's work directory as-is,
        but delete the target section's Markdown so the CLI's `--resume`
        regenerates only that one leaf, and (if a prompt modifier was given)
        rewrite its `summary` in `structure_graph.json` - the field
        `book_builder.py:generate_contents` sends the writer agent as
        `section_summary`.
        """
        work_dir = Path(run.work_dir)
        if not work_dir.is_dir():
            raise RuntimeError("work directory no longer exists; start a full run")
        out_dir = work_dir / book_command.OUT_DIRNAME
        graph_path = out_dir / "structure_graph.json"
        input_path = work_dir / book_command.INPUT_FILENAME
        if not graph_path.is_file() or not input_path.is_file():
            raise RuntimeError(
                "work directory is missing its base run's outputs; start a full run"
            )

        graph_data, current_sha256 = await run_in_threadpool(
            self._load_graph_and_input_sha256_sync, graph_path, input_path
        )
        stored_sha256 = str((graph_data.get("graph") or {}).get("input_sha256") or "").strip()
        if stored_sha256 and stored_sha256 != current_sha256:
            raise RuntimeError("the outline changed since the base run; start a full run")

        flat_nodes = await self._outline.list(run.project_id)
        positioned = {node.id: node for node in assign_positions(flat_nodes)}
        node = positioned.get(run.target_node_id) if run.target_node_id else None
        if node is None or not node.cli_key:
            raise RuntimeError("target outline node no longer exists; start a full run")
        cli_key = node.cli_key

        await run_in_threadpool(self._backup_and_delete_section_sync, out_dir, cli_key)

        # `content_file_path` still points at the file just deleted above -
        # clear it so `subprocess_runner`'s graph-watcher (seeded from
        # whatever nodes already have it set, to avoid re-announcing every
        # section a `--resume` run *isn't* touching) doesn't mistake this
        # node for already-done too and skip emitting its `"section"` event
        # once the CLI regenerates it.
        graph_changed = False
        cli_node = (graph_data.get("nodes") or {}).get(cli_key)
        if cli_node is not None and cli_node.get("content_file_path"):
            cli_node["content_file_path"] = ""
            graph_changed = True
        if run.options.prompt_modifier and cli_node is not None:
            base_summary = str(cli_node.get("summary") or "").strip()
            modifier_line = f"Writing instructions: {run.options.prompt_modifier}"
            cli_node["summary"] = (
                f"{base_summary}\n\n{modifier_line}" if base_summary else modifier_line
            )
            graph_changed = True
        if graph_changed:
            await run_in_threadpool(self._write_json_sync, graph_path, graph_data)

        kb_dir = work_dir / book_command.KB_DIRNAME
        if not kb_dir.is_dir():
            await self._download_sources(run)

    async def _prepare_export(self, run: Run) -> None:
        """`export`: reuse the base run's work directory verbatim - no
        section is deleted, so `--resume` skips every leaf and the CLI only
        (re)builds the requested `.tex`/`.pdf`."""
        work_dir = Path(run.work_dir)
        if not work_dir.is_dir():
            raise RuntimeError("work directory no longer exists; start a full run")
        out_dir = work_dir / book_command.OUT_DIRNAME
        if not (out_dir / "structure_graph.json").is_file():
            raise RuntimeError(
                "work directory is missing its base run's outputs; start a full run"
            )

    @staticmethod
    def _load_graph_and_input_sha256_sync(
        graph_path: Path, input_path: Path
    ) -> tuple[dict[str, Any], str]:
        graph_data = json.loads(graph_path.read_text(encoding="utf-8"))
        digest = hashlib.sha256()
        with input_path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return graph_data, digest.hexdigest()

    @staticmethod
    def _backup_and_delete_section_sync(out_dir: Path, cli_key: str) -> None:
        section_path = out_dir / "sections" / f"{cli_key}.md"
        if not section_path.is_file():
            return
        history_dir = out_dir / "regen_history"
        history_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(section_path, history_dir / f"{cli_key}.md.prev")
        section_path.unlink()

    @staticmethod
    def _write_json_sync(path: Path, data: dict[str, Any]) -> None:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

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
    ) -> tuple[int, bool]:
        event_queue: "queue.Queue[RunEvent]" = queue.Queue()
        cancel_event = threading.Event()
        subprocess_done = threading.Event()
        timed_out_event = threading.Event()

        # A run re-claimed after `requeue_stale` (worker crash, or the
        # previous attempt's session was poisoned before it could persist
        # a terminal status) resumes with events already committed for
        # this run.id - restart numbering from there, not 0, or the first
        # `append_batch` of this attempt violates `uq_run_events_run_id_seq`.
        start_seq = await self._events.max_seq(run.id)

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
                    start_seq=start_seq,
                    timed_out=timed_out_event,
                )
            finally:
                subprocess_done.set()

        async def drain_loop() -> None:
            # issue #48: a transient DB error here (Postgres restart,
            # connection reset, the run row cascade-deleted, a duplicate
            # `seq`) used to propagate immediately out of `asyncio.gather`,
            # leaving `run_subprocess()` running - and the CLI still
            # spending LLM tokens - with nothing left to ever flip
            # `cancel_event`. Retry a bounded number of times with backoff
            # first; only once that budget is exhausted do we set
            # `cancel_event` (so the concurrently-running `run_subprocess`
            # tears the child down via `subprocess_runner.run`'s own
            # SIGTERM -> SIGKILL handling) and re-raise, so `execute`'s
            # caller sees the child already terminated by the time it
            # catches this and calls `_fail`.
            consecutive_failures = 0
            while True:
                batch: list[RunEvent] = []
                try:
                    while len(batch) < _EVENT_BATCH_SIZE:
                        batch.append(event_queue.get_nowait())
                except queue.Empty:
                    pass
                try:
                    if batch:
                        await self._events.append_batch(run.id, batch)
                    current = await self._runs.get(run.id)
                    if current is not None and current.cancel_requested:
                        cancel_event.set()
                    await self._queue.heartbeat(run.id)
                except Exception:
                    consecutive_failures += 1
                    logger.exception(
                        "run %s: drain loop iteration failed (attempt %s/%s)",
                        run.id,
                        consecutive_failures,
                        _DRAIN_MAX_CONSECUTIVE_FAILURES,
                    )
                    if consecutive_failures > _DRAIN_MAX_CONSECUTIVE_FAILURES:
                        cancel_event.set()
                        raise
                    await asyncio.sleep(self._drain_poll_interval_s * consecutive_failures)
                    continue
                else:
                    consecutive_failures = 0

                if subprocess_done.is_set() and event_queue.empty():
                    break
                await asyncio.sleep(self._drain_poll_interval_s)

        # `return_exceptions=True` (rather than a bare `gather`, which
        # re-raises the first exception immediately and abandons the other
        # awaitable) makes `gather` wait for *both* to actually finish -
        # `drain_loop` sets `cancel_event` before re-raising above, and
        # `run_subprocess` polls it, so by the time this line returns the
        # child has already been torn down, not left orphaned.
        exit_code, drain_result = await asyncio.gather(
            run_subprocess(), drain_loop(), return_exceptions=True
        )
        if isinstance(exit_code, BaseException):
            # `subprocess_runner.run` itself doesn't raise in practice, but
            # guard against it anyway: make sure `drain_loop` (which may
            # still be waiting on `subprocess_done`) isn't left hanging, and
            # surface whichever exception actually explains the failure.
            subprocess_done.set()
            if isinstance(drain_result, BaseException) and drain_result is not exit_code:
                logger.error(
                    "run %s: drain loop also failed after run_subprocess raised",
                    run.id,
                    exc_info=drain_result,
                )
            raise exit_code
        if isinstance(drain_result, BaseException):
            raise drain_result
        return exit_code, timed_out_event.is_set()

    async def _finalize(
        self, run: Run, exit_code: int, project: Project, *, timed_out: bool = False
    ) -> Run:
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
            if timed_out:
                # Distinguish an API-enforced timeout from an ordinary CLI
                # crash (issue #80) - both exit with a SIGKILL-derived
                # negative code, but only one of them means "this may still
                # have produced usable, resumable output" rather than a
                # real failure.
                error = f"killed by API after {self._settings.cli_run_timeout_s:g}s timeout"
            else:
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
            if run.kind == RunKind.full:
                await self._import_graph(run, project)
            elif run.kind == RunKind.regenerate_section:
                await self._import_target_node(run, project)
            # export: no section was regenerated, nothing to sync back.
        elif run.kind == RunKind.regenerate_section:
            await self._revert_node_status(run)

        saved = await self._runs.update(run)
        await self._emit_done(saved)
        return saved

    async def _fail(self, run: Run, message: str, project: Project | None = None) -> Run:
        run.status = RunStatus.failed
        run.error = message
        run.finished_at = datetime.now(timezone.utc)
        await self._upload_artifacts(run, project)
        if run.kind == RunKind.regenerate_section:
            await self._revert_node_status(run)
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
                project,
                Path(run.work_dir),
                self._outline,
                self._sources,
                outline_mode=run.options.outline,
            )
            project.last_run_id = run.id
            project.updated_at = datetime.now(timezone.utc)
            await self._projects.update(project)
        except Exception:  # noqa: BLE001 - graph sync-back is best-effort
            logger.exception("run %s: failed to import structure_graph.json", run.id)

    async def _import_target_node(self, run: Run, project: Project) -> None:
        if run.target_node_id is None:
            return
        try:
            changed = await graph_import.import_single_node(
                project, Path(run.work_dir), run.target_node_id, self._outline
            )
            if not changed:
                # A "succeeded" run that produced no content change (e.g.
                # the target had no section file to regenerate) left the
                # node stuck at `drafting` forever, wasting a full CLI
                # invocation and the tokens it spent for nothing (issue
                # #77). Restore its pre-run status instead of chaining
                # `project.lastRunId` onto a run that changed nothing.
                await self._revert_node_status(run)
                return
            # A succeeded `regenerate_section` run is itself a valid base for
            # the next regenerate/export (same work dir, one more section
            # generated) - chain it the same way a `full` run does.
            project.last_run_id = run.id
            project.updated_at = datetime.now(timezone.utc)
            await self._projects.update(project)
        except Exception:  # noqa: BLE001 - graph sync-back is best-effort
            logger.exception("run %s: failed to import structure_graph.json", run.id)

    async def _revert_node_status(self, run: Run) -> None:
        if run.target_node_id is None or run.target_node_previous_status is None:
            return
        try:
            node = await self._outline.get(run.target_node_id)
            if node is None:
                return
            await self._outline.update(
                dataclass_replace(
                    node,
                    status=run.target_node_previous_status,
                    updated_at=datetime.now(timezone.utc),
                )
            )
        except Exception:  # noqa: BLE001 - status revert is best-effort
            logger.exception("run %s: failed to revert target node status", run.id)

    async def _emit_done(self, run: Run) -> None:
        next_seq = await self._events.max_seq(run.id) + 1
        await self._events.append_batch(run.id, [build_done_event(run, next_seq)])
