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
import re
import shutil
import threading
import uuid
from dataclasses import asdict as dataclass_asdict
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

# Matches an absolute filesystem path (`/app/runs/<uuid>/out/...`, a MinIO/S3
# endpoint URL's path component, ...) or an `http(s)://` URL - the shapes a
# raw boto3/OSError message tends to carry (issue #82). Two or more path
# segments after the leading `/`, so short, harmless things aren't flagged.
_SENSITIVE_MESSAGE_RE = re.compile(r"https?://|/(?:[\w.\-]+/)+[\w.\-]*")

_GENERIC_RUN_FAILURE_MESSAGE = (
    "run failed due to an internal error; see the worker logs for details"
)


def _sanitize_run_error(message: str) -> str:
    """`GenerationService.execute`'s catch-all hands whatever exception it
    caught here to `_fail`, which persists it verbatim as `run.error` and
    the terminal `done` event's payload - both returned directly to API
    clients. A raw `str(exc)` can carry a boto3 S3 endpoint URL and
    bucket/key, or an absolute filesystem path under the run's work
    directory; neither belongs in a client-facing response (issue #82). The
    real exception, with its real message and traceback, is always still
    logged server-side by `execute`'s `logger.exception` right before this
    runs - only what's stored/returned to the API is generalized here, and
    only when it actually looks sensitive (an ordinary, already-safe message
    like `"CLI exited with code 1"` or a deliberately-raised, human-authored
    `RuntimeError` passes through unchanged)."""
    if _SENSITIVE_MESSAGE_RE.search(message):
        return _GENERIC_RUN_FAILURE_MESSAGE
    return message


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
        allow_subdivision: bool = True,
        enable_web_rag: bool = False,
        audit_book: bool = False,
        audit_book_mode: Literal["off", "warn", "strict"] = "warn",
        legacy_tex: bool = False,
        fail_fast_schema: bool = False,
        started_by: uuid.UUID | None = None,
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
            fail_fast_schema=fail_fast_schema,
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
            started_by=started_by,
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
        # Only these two columns - a concurrent `PATCH /projects/{id}`
        # reading `project` in between must not have its own change
        # reverted by this write's stale copy of everything else (issue
        # #56).
        await self._projects.update(project, fields=("last_run_id",))
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
        if run.status not in (RunStatus.queued, RunStatus.running):
            raise Conflict(f"run {run_id} is already {run.status.value}")

        # `request_cancel` only ever touches the specific column(s) each
        # transition needs, guarded by the row's *current* status, instead
        # of overwriting the whole row from this (potentially already
        # stale) `run` snapshot - see its docstring for the lost-update race
        # this closes (issue #56): a queued run claimed by a worker, or a
        # running run that the worker's own `_finalize`/`_fail` finished,
        # in the narrow window between the read above and this write.
        saved = await self._runs.request_cancel(run_id)
        if saved is None:
            raise NotFound(f"run {run_id} does not exist")

        if saved.status == RunStatus.cancelled:
            # We won the "queued -> cancelled" transition (a worker never
            # got to claim it first) - the worker's own `_finalize`/`_fail`
            # never run for this run, so do here what they would have done:
            # without a "done" event, `GET /runs/{id}/events/stream` polled
            # forever (issue #63), and a `regenerate_section` target node
            # stayed at `drafting` forever.
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
                        ),
                        fields=("status",),
                    )
            next_seq = await self._events.max_seq(run_id) + 1
            await self._events.append_batch(run_id, [build_done_event(saved, next_seq)])
        # Else: still `running` (a worker holds it) - `cancel_requested` is
        # now set, and the worker's own drain loop/`_finalize` will notice
        # and wind it down; there's nothing more for the API to do here.
        return saved

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
        # One batched lookup instead of one `SELECT` per artifact (issue
        # #51) - a run produces one artifact per section plus reviews, so
        # 50-200 rows here is normal.
        files_by_id = await self._files.get_many([artifact.file_id for artifact in artifacts_])
        pairs = [
            (artifact, files_by_id[artifact.file_id])
            for artifact in artifacts_
            if artifact.file_id in files_by_id
        ]
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
        started_by: uuid.UUID | None = None,
    ) -> Run:
        project = await self._projects.get(project_id)
        if project is None:
            raise NotFound(f"project {project_id} does not exist")

        flat = await self._outline.list(project_id)
        flat_by_id = {n.id: n for n in flat}
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
        # `full` run.
        if base_run.options.outline == "generate":
            # A `generate`-mode base run never sent the outline to the CLI
            # at all (`_prepare_work_dir`'s `include_outline=False`), so the
            # rendered spec TXT below is just the project header regardless
            # of outline edits - hashing it can never detect drift here.
            # Instead, compare this node's `cli_key` *as recorded at import
            # time* (`graph_import._new_node`, issue #58/#62) against what
            # the outline's *current* shape recomputes for it
            # (`node.cli_key`, from `positioned` above) - a structural edit
            # anywhere that shifts this node's position changes the
            # recomputed key, which is exactly the drift that would
            # otherwise make `_prepare_regenerate` delete/regenerate the
            # wrong CLI section and `import_single_node` write its content
            # back onto the wrong outline row. A node imported before this
            # persistence existed has no stored `cli_key` to compare
            # against - nothing to detect drift with, so (as before) it's
            # let through.
            stored_cli_key = flat_by_id[node_id].cli_key
            if stored_cli_key and stored_cli_key != node.cli_key:
                raise Conflict(
                    "the outline has changed since the base run; start a full run"
                )
        else:
            # Re-rendering the current project/outline into the same TXT
            # `_prepare_work_dir` would have produced and comparing its
            # hash to what the base run actually saw catches structural
            # drift here, synchronously, instead of only failing once the
            # worker gets to it.
            outline_tree = build_tree(flat)
            current_txt = SpecRenderer.render(project, outline_tree, include_outline=True)
            current_sha256 = hashlib.sha256(current_txt.encode("utf-8")).hexdigest()
            stored_sha256 = await run_in_threadpool(_read_graph_input_sha256, base_run.work_dir)
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
            started_by=started_by,
        )
        created = await self._runs.add(run)
        await self._outline.update(
            dataclass_replace(node, status=NodeStatus.DRAFTING, updated_at=now),
            fields=("status",),
        )
        return created

    async def export(
        self,
        run_id: uuid.UUID,
        *,
        output_format: Literal["latex", "pdf"],
        started_by: uuid.UUID | None = None,
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
            started_by=started_by,
        )
        return await self._runs.add(run)

    async def retry(self, run_id: uuid.UUID, *, started_by: uuid.UUID | None = None) -> Run:
        """Resume a `failed`/`cancelled` `full` run from its own `work_dir`
        (issue #124): a new `full` run, `options.resume=True`, sharing the
        old run's `work_dir` - exactly the `regenerate_node`/`export`
        pattern (new row, same directory, `base_run_id` pointing at the
        run being resumed), scoped to `full` only. The failed/cancelled row
        itself is left completely untouched - it stays the historical
        record of that attempt."""
        run = await self._get(run_id)

        blocker = await run_in_threadpool(retry_blocker, run)
        if blocker is not None:
            raise Conflict(blocker)

        active = await self._runs.get_active_for_project(run.project_id)
        if active is not None:
            raise Conflict(
                f"project {run.project_id} already has an active run ({active.id}, "
                f"status={active.status.value})"
            )

        project = await self._projects.get(run.project_id)
        if project is None:
            raise NotFound(f"project {run.project_id} does not exist")

        # Outline-drift guard (required, not optional - see issue #124):
        # `book_pipeline.py`'s own `--resume` short-circuit compares the
        # `input_sha256` recorded in `structure_graph.json` against the
        # current `book_input.txt`, and on a mismatch silently starts a
        # brand-new run from scratch at full LLM cost instead of resuming -
        # the worst possible outcome for a "resume" action. Since
        # `_prepare_work_dir` re-renders `book_input.txt` from the current
        # project/outline on every `full` run, any edit since this run
        # failed would trigger exactly that. `outline: "generate"` renders
        # only the project header (`include_outline=False`) regardless of
        # outline edits, so hashing it still catches a title/author/topic
        # edit - the only kind of drift that can matter when a retry
        # resumes the whole graph rather than one node.
        flat = await self._outline.list(run.project_id)
        outline_tree = build_tree(flat)
        include_outline = run.options.outline == "project"
        current_txt = SpecRenderer.render(project, outline_tree, include_outline=include_outline)
        current_sha256 = hashlib.sha256(current_txt.encode("utf-8")).hexdigest()
        stored_sha256 = await run_in_threadpool(_read_graph_input_sha256, run.work_dir)
        if stored_sha256 and stored_sha256 != current_sha256:
            raise Conflict("the project or outline has changed since this run; start a full run")

        # A `work_dir` with an already-`succeeded` sibling (the base run
        # itself, or an earlier retry of it) means the book is already
        # done there - `--resume` would skip every section and "succeed"
        # having regenerated nothing, the same wasted-run class as issue
        # #77.
        siblings = await self._runs.list_by_work_dir(run.work_dir)
        if any(sibling.id != run.id and sibling.status == RunStatus.succeeded for sibling in siblings):
            raise Conflict(
                f"run {run.id}'s work directory already has a succeeded run on it; "
                "nothing to resume"
            )

        now = datetime.now(timezone.utc)
        options = dataclass_replace(
            run.options, resume=True, export_tex_only=False, prompt_modifier=None
        )
        new_run = Run(
            id=uuid.uuid4(),
            project_id=run.project_id,
            kind=RunKind.full,
            status=RunStatus.queued,
            options=options,
            base_run_id=run.id,
            target_node_id=None,
            target_node_previous_status=None,
            work_dir=run.work_dir,
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
            started_by=started_by,
        )
        created = await self._runs.add(new_run)

        # `last_run_id` is deliberately left untouched, same reasoning as
        # `create()` (issue #66): this run hasn't succeeded yet. Only the
        # activity-ordering `updated_at` bump happens here.
        project.updated_at = now
        await self._projects.update(project, fields=("last_run_id",))
        return created


def retry_blocker(run: Run) -> str | None:
    """The 409 reason `POST /runs/{id}/retry` would raise for `run`'s
    *intrinsic* preconditions - `kind == full`, `status` terminal in a
    resumable way, work dir present, `structure_graph.json` present - or
    `None` if they all hold. Shared verbatim by `RunService.retry` (which
    layers its own transient/project-level guards - active run, outline
    drift, a succeeded sibling - on top as additional 409s) and
    `run_to_schema`'s `retryable` flag (issue #124), so the flag can never
    say "retryable" for a run the endpoint would actually reject on these
    grounds. Kind/status are checked before either `stat(2)` so a list of
    runs only pays the filesystem cost for `full` runs that are actually
    `failed`/`cancelled`."""
    if run.kind != RunKind.full:
        return "only a full run can be resumed; re-run regenerate/export instead"
    if run.status == RunStatus.succeeded:
        return f"run {run.id} succeeded; nothing to resume; use export/regenerate"
    if run.status in (RunStatus.queued, RunStatus.running):
        return f"run {run.id} is still active; cancel it first"
    work_dir = Path(run.work_dir)
    if not work_dir.is_dir():
        return f"run {run.id}'s work directory no longer exists; start a full run"
    if not (work_dir / book_command.OUT_DIRNAME / "structure_graph.json").is_file():
        return f"run {run.id} never produced a structure graph; start a full run"
    if not _read_graph_input_sha256(run.work_dir):
        # `book_pipeline.py`'s own `--resume` short-circuit needs
        # `graph.input_sha256` to decide whether it's safe to resume at
        # all - a graph missing it (e.g. the run died before finishing its
        # first write of the graph) makes the CLI itself refuse `--resume`
        # and silently rebuild the whole book from scratch at full LLM
        # cost, which is exactly the outcome the drift guard below exists
        # to prevent. Block it here too, rather than only catching drift
        # once there's a hash to compare against.
        return f"run {run.id}'s structure graph has no recorded input hash; start a full run"
    return None


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


async def sweep_orphaned_work_dirs(run_repository: RunRepository, runs_dir: str) -> int:
    """Remove any directory directly under `RUNS_DIR` that no `runs` row
    references at all, regardless of status (issue #57). `ProjectService.
    delete` soft-deletes a project now, so its `runs` rows (and their
    `work_dir`s) survive going forward - but a project hard-deleted before
    that fix landed already cascaded its `runs` rows away, permanently
    orphaning that project's (potentially hundreds of MB) work directories
    with nothing left in the database to ever find them by. Unlike
    `sweep_stale_work_dirs`, this doesn't wait out `retention_days`: a
    directory with zero referencing rows isn't "idle", it's unreferenced
    garbage the moment it's found - there's no in-flight run it could
    possibly still belong to."""
    runs_root = Path(runs_dir)
    if not runs_root.is_dir():
        return 0
    known = {
        str(Path(work_dir).resolve()) for work_dir in await run_repository.list_all_work_dirs()
    }
    removed = 0
    for entry in sorted(runs_root.iterdir()):
        if not entry.is_dir():
            continue
        if str(entry.resolve()) not in known:
            await run_in_threadpool(shutil.rmtree, entry, True)
            removed += 1
    return removed


def _read_run_meta(work_dir: str) -> dict[str, Any] | None:
    path = Path(work_dir) / book_command.OUT_DIRNAME / "run_meta.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _run_meta_belongs_to_this_attempt(
    run_meta: dict[str, Any] | None, started_at: datetime | None
) -> bool:
    """A `regenerate_section`/`export` run shares its base run's `work_dir`
    verbatim. If *this* run is cancelled or times out, the CLI subprocess is
    killed via SIGTERM/SIGKILL and never reaches the `finally` in
    `llm_usage.write_run_meta` that (re)writes `run_meta.json` - so the file
    still sitting there is whatever the base run (or an earlier attempt of
    this same run, before a stale-requeue) left behind. Nothing about
    `run_meta.json`'s own contents identifies which run wrote it (the CLI's
    `run_id` is an internal timestamp, unrelated to the API's `Run.id`), so
    the only way to tell it's stale is to compare when it was written
    against when *this* attempt actually started (issue #81) - a
    `run_meta.json` that finished before this attempt even claimed the run
    can't possibly be this attempt's own output. Attributing a stale file's
    totals/error to this run would double-count cost and misattribute a
    failure that was really the base run's."""
    if not run_meta or started_at is None:
        return False
    finished_at_raw = run_meta.get("finished_at")
    if not isinstance(finished_at_raw, str):
        return False
    try:
        finished_at = datetime.fromisoformat(finished_at_raw)
    except ValueError:
        return False
    if finished_at.tzinfo is None:
        finished_at = finished_at.replace(tzinfo=timezone.utc)
    return finished_at >= started_at


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
        worker_id: str | None = None,
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
        # Identifies this `GenerationService` to the `heartbeat`/`finalize`/
        # `release` compare-and-set checks below as the worker slot that
        # holds (or held) this run's lease - `None` for callers that drive
        # `execute` directly against an unclaimed run (most unit tests),
        # which keeps their previous unconditional-while-`running`
        # behavior. The real worker (`api/worker/__main__.py`) always
        # passes the same id it claimed the run with.
        self._worker_id = worker_id
        self._lease_lost = False
        # Set by `_prepare_regenerate` for a `regenerate_section` run, so
        # `_rollback_regenerate` (from `_fail`/`_finalize`) knows which
        # `regen_history/` backups are this attempt's own (issue #58).
        self._regenerate_cli_key: str | None = None

    async def execute(self, run: Run, *, shutdown_event: asyncio.Event | None = None) -> Run:
        project = await self._projects.get(run.project_id)
        if project is None:
            return await self._fail(run, "project no longer exists")

        self._lease_lost = False
        try:
            if run.kind == RunKind.full:
                if run.options.resume and run.base_run_id is not None:
                    # A retry (issue #124): closes the TOCTOU window
                    # between `RunService.retry` validating the work dir
                    # and this worker actually claiming the run -
                    # `sweep_stale_work_dirs` could have `rmtree`'d it in
                    # between. Without this check, `_prepare_work_dir`
                    # below would silently `mkdir` a fresh directory and
                    # the "resume" would become a full-cost run with no
                    # warning.
                    work_dir = Path(run.work_dir)
                    graph_path = work_dir / book_command.OUT_DIRNAME / "structure_graph.json"
                    resumable = await run_in_threadpool(
                        lambda: work_dir.is_dir() and graph_path.is_file()
                    )
                    if not resumable:
                        raise RuntimeError(
                            "work directory no longer exists; start a full run"
                        )
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
            exit_code, timed_out = await self._run_subprocess_and_drain(
                run, argv, env, cwd, shutdown_event=shutdown_event
            )

            if shutdown_event is not None and shutdown_event.is_set():
                # The worker container is stopping: the CLI subprocess was
                # already SIGTERM'd (via `should_cancel` below), so hand the
                # run back to the queue right away instead of leaving it
                # `running` until `WORKER_STALE_S` elapses and
                # `requeue_stale` reclaims it (issue #52).
                return await self._release_for_shutdown(run)
            if self._lease_lost:
                # `requeue_stale` already reassigned this run to another
                # worker while we were still executing it (our own
                # heartbeats stopped being accepted, see
                # `_run_subprocess_and_drain`'s drain loop) - the new owner
                # is responsible for finalizing it now, not us; writing our
                # own outcome here would race (and could clobber) theirs.
                logger.warning(
                    "run %s: lost worker lease mid-execution; abandoning without finalizing",
                    run.id,
                )
                current = await self._runs.get(run.id)
                return current if current is not None else run

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
            return await self._fail(run, _sanitize_run_error(str(exc)), project)

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
        # Stashed so `_rollback_regenerate` (called from `_fail`/`_finalize`
        # if this run doesn't succeed) knows which backups under
        # `regen_history/` belong to *this* attempt, without having to
        # re-derive `cli_key` from the outline at that point (issue #58).
        self._regenerate_cli_key = cli_key

        # Snapshot both the section content and the whole `structure_graph.
        # json` *before* mutating either - if the CLI then fails or is
        # cancelled, `_rollback_regenerate` restores both from here so the
        # base work dir ends up exactly as it was before this run touched
        # it, instead of permanently missing a section and carrying a
        # leftover prompt-modifier trailer into every later `export`/
        # `regenerate` on the same work dir (issue #58).
        await run_in_threadpool(self._backup_before_regenerate_sync, out_dir, graph_path, cli_key)

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
            # Strip any trailer a *previous* regenerate on this same node
            # left behind before appending this attempt's - otherwise every
            # subsequent regenerate stacks another "Writing instructions:"
            # line onto the graph's copy of the summary (issue #58).
            base_summary = graph_import._strip_synthesized_writing_instructions(
                str(cli_node.get("summary") or "")
            )
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
    def _backup_before_regenerate_sync(out_dir: Path, graph_path: Path, cli_key: str) -> None:
        history_dir = out_dir / "regen_history"
        history_dir.mkdir(parents=True, exist_ok=True)
        # The graph is always backed up (there's always a `structure_graph.
        # json` by the time this runs - `_prepare_regenerate` already
        # checked `graph_path.is_file()`), even though it isn't rewritten
        # until later in the same call, so the backup is guaranteed to be
        # this attempt's pre-mutation state.
        shutil.copyfile(graph_path, history_dir / "structure_graph.json.prev")
        section_path = out_dir / "sections" / f"{cli_key}.md"
        if section_path.is_file():
            shutil.copyfile(section_path, history_dir / f"{cli_key}.md.prev")
            section_path.unlink()

    @staticmethod
    def _rollback_regenerate_sync(out_dir: Path, cli_key: str) -> None:
        """Undo `_backup_before_regenerate_sync`'s mutations: restore
        `structure_graph.json` and the target section's Markdown from their
        pre-attempt backups (or, if a section didn't exist before this
        attempt - no backup was ever taken for it - remove whatever a
        failed/cancelled CLI run may have partially written), then clear
        the backups so a *later* regenerate attempt on this node doesn't
        find and restore this one's stale snapshot instead of its own."""
        history_dir = out_dir / "regen_history"
        graph_backup = history_dir / "structure_graph.json.prev"
        section_backup = history_dir / f"{cli_key}.md.prev"
        graph_path = out_dir / "structure_graph.json"
        section_path = out_dir / "sections" / f"{cli_key}.md"

        if graph_backup.is_file():
            shutil.copyfile(graph_backup, graph_path)
            graph_backup.unlink()

        if section_backup.is_file():
            section_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(section_backup, section_path)
            section_backup.unlink()
        elif section_path.is_file():
            section_path.unlink()

    async def _rollback_regenerate(self, run: Run) -> None:
        if run.kind != RunKind.regenerate_section or not self._regenerate_cli_key:
            return
        out_dir = Path(run.work_dir) / book_command.OUT_DIRNAME
        try:
            await run_in_threadpool(
                self._rollback_regenerate_sync, out_dir, self._regenerate_cli_key
            )
        except Exception:  # noqa: BLE001 - rollback is best-effort
            logger.exception("run %s: failed to roll back regenerate changes", run.id)

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
            await self._write_source_sync(dest_dir, dest, file.storage_key)
            # This loop is the "before the CLI even starts" phase
            # `_run_subprocess_and_drain`'s drain loop isn't running yet to
            # cover - a project with many KB sources on a slow object-store
            # volume can spend well over `WORKER_STALE_S` here alone.
            # Heartbeating between files (not just once at the very end)
            # keeps `requeue_stale` from handing this run to a second
            # worker while this one is still downloading (issue #52); a
            # rejected heartbeat means our lease is already gone, so bail
            # out now instead of finishing a download nobody will use.
            if not await self._queue.heartbeat(run.id, self._worker_id):
                self._lease_lost = True
                raise RuntimeError(
                    f"worker lease for run {run.id} was lost while downloading sources"
                )

    async def _write_source_sync(self, dest_dir: Path, dest: Path, storage_key: str) -> None:
        # Streamed straight to disk chunk-by-chunk rather than buffered
        # fully in memory first (issue #55) - a KB source can be a
        # multi-hundred-MB PDF, and holding the whole thing in a Python
        # list before ever writing a byte doubles peak memory for no
        # reason.
        await run_in_threadpool(dest_dir.mkdir, parents=True, exist_ok=True)
        handle = await run_in_threadpool(dest.open, "wb")
        try:
            async for chunk in await self._storage.open(storage_key):
                await run_in_threadpool(handle.write, chunk)
                # Flushed per chunk (not just left buffered until `close()`)
                # so a chunk actually lands on disk as it arrives rather
                # than sitting in Python's userspace file buffer - keeping
                # this a real streaming write, not just a write that
                # happens to be split into smaller in-memory pieces.
                await run_in_threadpool(handle.flush)
        finally:
            await run_in_threadpool(handle.close)

    async def _run_subprocess_and_drain(
        self,
        run: Run,
        argv: list[str],
        env: dict[str, str],
        cwd: str,
        *,
        shutdown_event: asyncio.Event | None = None,
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
            return cancel_event.is_set() or (shutdown_event is not None and shutdown_event.is_set())

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
                    # Compare-and-set: `False` means `requeue_stale` already
                    # decided our lease was gone and handed this run to
                    # another worker - tear our own subprocess down instead
                    # of racing that worker to the finish line (issue #52).
                    if not await self._queue.heartbeat(run.id, self._worker_id):
                        self._lease_lost = True
                        cancel_event.set()
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
        run_meta = await run_in_threadpool(_read_run_meta, run.work_dir)
        if not _run_meta_belongs_to_this_attempt(run_meta, run.started_at):
            # A cancelled/timed-out regenerate_section/export run shares its
            # base run's work_dir, and its own CLI subprocess never got to
            # rewrite run_meta.json (issue #81) - what's on disk is the base
            # run's (or an earlier attempt's) leftover output. Don't
            # attribute its totals/error to this run.
            run_meta = None
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
            await self._rollback_regenerate(run)
            await self._revert_node_status(run)

        return await self._persist_terminal_outcome(run)

    async def _fail(self, run: Run, message: str, project: Project | None = None) -> Run:
        run.status = RunStatus.failed
        run.error = message
        run.finished_at = datetime.now(timezone.utc)
        await self._upload_artifacts(run, project)
        if run.kind == RunKind.regenerate_section:
            await self._rollback_regenerate(run)
            await self._revert_node_status(run)
        return await self._persist_terminal_outcome(run)

    async def _persist_terminal_outcome(self, run: Run) -> Run:
        """Write `run`'s terminal fields via the compare-and-set `finalize`
        (guarded on `status='running'`, and on `locked_by` too when this
        service was constructed with a `worker_id`) rather than
        `RunRepository.update`'s blind full-row overwrite - closes the
        lost-update races from issues #52 (a second worker reclaimed this
        run after `requeue_stale`) and #56 (`RunService.cancel` committed a
        `running` -> `cancelled` transition in between). A `None` result
        means we lost that race: whoever's write *did* land already owns
        emitting the "done" event, so this just returns the row's current,
        authoritative state instead."""
        saved = await self._runs.finalize(run, expected_locked_by=self._worker_id)
        if saved is None:
            logger.warning(
                "run %s: finalize lost the compare-and-set (status/lease changed "
                "concurrently); not overwriting the winning write",
                run.id,
            )
            current = await self._runs.get(run.id)
            return current if current is not None else run
        await self._emit_done(saved)
        return saved

    async def _release_for_shutdown(self, run: Run) -> Run:
        """The worker container received SIGTERM: `_run_subprocess_and_
        drain`'s `should_cancel` already SIGTERM'd (then, if needed,
        SIGKILL'd) the CLI child, so the run is no longer making progress
        under this worker. Hand it back to `queued` right away instead of
        leaving it `running` for up to `WORKER_STALE_S` until
        `requeue_stale` notices (issue #52) - a `full` run whose
        `structure_graph.json` already exists gets `options.resume`
        flipped on first, the same way a stale-requeued one does, so
        whichever worker picks it up next resumes instead of starting
        over."""
        resume = run.options.resume
        if run.kind == RunKind.full and not resume:
            graph_path = Path(run.work_dir) / book_command.OUT_DIRNAME / "structure_graph.json"
            resume = await run_in_threadpool(graph_path.is_file)

        options = (
            dataclass_asdict(dataclass_replace(run.options, resume=True)) if resume else None
        )
        released = await self._queue.release(run.id, self._worker_id, options=options)
        if not released:
            logger.warning(
                "run %s: could not release for shutdown (lease already lost); "
                "leaving it to requeue_stale",
                run.id,
            )
        current = await self._runs.get(run.id)
        return current if current is not None else run

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
            await self._projects.update(project, fields=("last_run_id",))
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
            await self._projects.update(project, fields=("last_run_id",))
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
                ),
                fields=("status",),
            )
        except Exception:  # noqa: BLE001 - status revert is best-effort
            logger.exception("run %s: failed to revert target node status", run.id)

    async def _emit_done(self, run: Run) -> None:
        next_seq = await self._events.max_seq(run.id) + 1
        await self._events.append_batch(run.id, [build_done_event(run, next_seq)])
