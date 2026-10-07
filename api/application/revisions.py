"""The copilot revision service (issue #182, phase 4).

A *revision* asks the model to rewrite one section (or one selected range of
it) of an outline node. It is stored as a `kind=suggestion` margin card:
`running` while the job works, then `pending` (a diff awaiting accept / reject),
`failed` or `cancelled`; accepting writes the node's text. Two classes:

* `RevisionService` - request scoped: validation, creating the suggestion row,
  accept / reject / cancel, the Rewrite delegation.
* `RevisionRunner` - process wide (one per API process, created and closed in
  the app lifespan): runs the jobs as asyncio tasks through ONE
  `engine.ReviseClientPool`, persists progress, and recovers from crashes.

Design for several API replicas
-------------------------------
The database is the only shared state; a job is an asyncio task in exactly one
process (its *owner*) and everything another replica needs is in the DB:

* state machine: the suggestion row's `status`, only ever changed by
  compare-and-set (`CommentRepository.transition_suggestion`), so concurrent
  cancel / finish / accept / reject / recovery cannot clobber each other;
* `revision_jobs` (one row per job): `owner` (a per-process instance id),
  `heartbeat_at` (refreshed every `REVISION_HEARTBEAT_S`) and
  `cancel_requested`;
* `revision_events`: the engine's progress events, written by the owner,
  tailed by `GET /suggestions/{id}/events/stream` on whichever replica the
  client reached (the terminal `done|failed|cancelled` event is synthesised
  from the row's status, so no replica needs to coordinate its seq);
* cancel on any replica: CAS `running -> cancelled` in the DB; the owner polls
  its row every second, sees the status change and cancels its task (a replica
  that happens to own the task cancels it immediately and records the usage);
* recovery: every replica runs a sweeper that fails `running` suggestions whose
  heartbeat is older than `REVISION_STALE_S` (code `interrupted`), and on
  startup also those owned by an earlier process of the same host name (a
  restarted container / pod), so a restart does not leave cards spinning.

Limits: a job dies with its process (the user sees `interrupted` and asks
again); a heartbeat gap longer than `REVISION_STALE_S` (a frozen process) gets
the job failed although it might still finish - its late result is then
discarded by the CAS; usage of a job killed with its process is not recorded.
One running revision per node (unique index), `REVISION_MAX_PER_USER` per user
(admission is serialised per user with a row lock on the user, held until the
suggestion row is committed, so simultaneous starts cannot exceed it; liveness
is judged against the database clock). Startup recovery by host name assumes one
API process per host name (a no-op where pods get fresh names - the heartbeat
sweep covers that; `--workers > 1` is unsupported).
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import os
import re
import socket
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal, Mapping

import httpx
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.concurrency import run_in_threadpool

from engine.config import LLMSettings, is_openrouter
from engine.errors import (
    AnchorOrphaned,
    ConfigError,
    InputError,
    ReviseAuthError,
    ReviseConfigError,
    ReviseError,
    ReviseProviderError,
    ReviseRateLimited,
    ReviseTimeout,
    ReviseUnusableOutput,
)
from engine.util.anchors import make_anchor
from engine.revision import (
    ReviseClientPool,
    ReviseParams,
    ReviseRequest,
    SectionBrief,
    interactive_llm_settings,
    load_revision_retrieval,
)

from api.application.comment_anchors import ACCEPTED_LEVELS, resolve_anchor_level
from api.application.reanchor import reanchor_node_cards
from api.application.revision_apply import (
    MalformedSuggestion,
    StaleSuggestion,
    apply_revision,
    content_hash,
)
from api.application.runs import LLM_KEY_REQUIRED_CODE, LLM_KEY_REQUIRED_MESSAGE
from api.core.errors import Conflict, Forbidden, NotFound, TooManyRequests, ValidationFailed
from api.core.secrets import LlmKeyCipher, LlmKeyDecryptError
from api.core.settings import Settings
from api.domain.models import (
    CommentKind,
    CommentStatus,
    NodeComment,
    NodeStatus,
    OutlineNode,
    Project,
    RevisionEvent,
    Run,
    RunKind,
    RunStatus,
    User,
)
from api.domain.outline import assign_positions, build_tree
from api.domain.ports import (
    CommentRepository,
    OutlineRepository,
    ProjectRepository,
    RunRepository,
    UserRepository,
)
from api.infrastructure.cli import book_command
from api.infrastructure.db.revision_repository import SqlAlchemyRevisionRepository

logger = logging.getLogger("api.application.revisions")

Verb = Literal["revise", "rewrite"]
Scope = Literal["section", "range"]

MAX_THREADS_PER_REVISION = 25
MAX_THREAD_CHARS = 3000
_URL_RE = re.compile(r"https?://\S+")

ERROR_MESSAGES = {
    "anchor_orphaned": "The selected text can no longer be found in the section. Select it again.",
    "llm_config": "No usable LLM configuration is available for this revision.",
    "llm_auth": "The LLM provider rejected the API key.",
    "llm_rate_limited": "The LLM provider is rate limiting requests. Try again in a moment.",
    "llm_timeout": "The LLM provider did not answer in time. Try again.",
    "llm_error": "The LLM provider failed to answer. Try again.",
    "unusable_output": "The model's answer could not be used. Try again or rephrase the request.",
    "timeout": "The revision did not finish in time.",
    "interrupted": "The server restarted while this revision was running. Try again.",
    "internal": "The revision failed due to an internal error.",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.isoformat()


def map_error(exc: BaseException) -> tuple[str, str, dict[str, Any]]:
    """`(code, message, usage)` for a failed job. Provider failures get fixed
    messages (their text can carry key fragments or URLs); the engine's own
    messages about the model's output are shown with URLs removed."""
    usage = dict(getattr(exc, "usage", None) or {})
    if isinstance(exc, AnchorOrphaned):
        code = "anchor_orphaned"
    elif isinstance(exc, ReviseConfigError):
        code = "llm_config"
    elif isinstance(exc, ReviseAuthError):
        code = "llm_auth"
    elif isinstance(exc, ReviseRateLimited):
        code = "llm_rate_limited"
    elif isinstance(exc, ReviseTimeout):
        code = "llm_timeout"
    elif isinstance(exc, ReviseUnusableOutput):
        code = "unusable_output"
    elif isinstance(exc, ReviseProviderError):
        code = "llm_error"
    elif isinstance(exc, ReviseError):
        message = _URL_RE.sub("<url>", str(exc)).strip() or "The revision failed."
        return "revision_failed", message[:500], usage
    elif isinstance(exc, InputError):
        message = _URL_RE.sub("<url>", str(exc)).strip() or "The request cannot be revised."
        return "invalid_request", message[:500], usage
    elif isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        code = "timeout"
    else:
        code = "internal"
    return code, ERROR_MESSAGES[code], usage


def _json_safe(value: Any) -> Any:
    return json.loads(json.dumps(value, default=str, ensure_ascii=False))


# ------------------------------------------------------------------- events
class DbEventSink:
    """An `engine.EventSink` that buffers events for the job's flusher to write
    to `revision_events`. Thread-safe (the engine may emit from a worker
    thread)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._events: list[dict[str, Any]] = []
        self.last_usage: dict[str, Any] = {}

    def emit(
        self,
        stage: str,
        message: str,
        *,
        level: str = "info",
        node_key: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        if level == "debug":
            return
        try:
            safe_payload = _json_safe(payload) if payload is not None else None
        except (TypeError, ValueError):
            safe_payload = None
        if isinstance(safe_payload, dict) and isinstance(safe_payload.get("usage"), dict):
            self.last_usage = safe_payload["usage"]
        record = {
            "ts": _now(),
            "stage": stage,
            "level": level,
            "message": _URL_RE.sub("<url>", " ".join(str(message).split()))[:1000],
            "payload": safe_payload,
        }
        with self._lock:
            self._events.append(record)

    def close(self) -> None:
        return None

    def drain(self) -> list[dict[str, Any]]:
        with self._lock:
            events, self._events = self._events, []
        return events


# --------------------------------------------------------------------- job
@dataclass
class RevisionJob:
    """Everything a job needs, captured when the request was validated."""

    comment_id: uuid.UUID
    project_id: uuid.UUID
    node_id: uuid.UUID
    request: ReviseRequest
    base_payload: dict[str, Any]  # the request echo (verb, scope, instruction, params, ...)
    retrieval_dir: Path | None = None
    kb_sources: tuple[str, ...] | None = None
    extra_warnings: tuple[str, ...] = ()


class RevisionRunner:
    """Process-wide owner of the revision jobs (see the module docstring)."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        settings: Settings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        env: Mapping[str, str] | None = None,
        hostname: str | None = None,
        poll_interval_s: float = 1.0,
        sweep_interval_s: float | None = None,
    ) -> None:
        self._session_factory = session_factory
        self._settings = settings
        self._transport = transport
        self._env = env
        self.hostname = hostname or socket.gethostname()
        self.instance_id = f"{self.hostname}:{uuid.uuid4().hex[:12]}"
        self._poll_interval_s = poll_interval_s
        self._sweep_interval_s = (
            sweep_interval_s if sweep_interval_s is not None else max(1.0, settings.revision_stale_s / 3)
        )
        self._pool: ReviseClientPool | None = None
        self._tasks: dict[uuid.UUID, asyncio.Task] = {}
        self._reasons: dict[uuid.UUID, str] = {}
        self._records: set[asyncio.Future] = set()
        self._sweeper: asyncio.Task | None = None
        self._closing = False

    # ---------------------------------------------------------- lifecycle
    @property
    def pool(self) -> ReviseClientPool:
        # Created lazily so it belongs to the event loop that first uses it.
        if self._pool is None:
            self._pool = ReviseClientPool(
                concurrency=self._settings.revision_llm_concurrency, transport=self._transport
            )
        return self._pool

    @property
    def running_jobs(self) -> int:
        return sum(1 for t in self._tasks.values() if not t.done())

    async def start(self) -> None:
        """Fail the suggestions an earlier process of this host left `running`,
        then keep sweeping for jobs whose owner died."""
        self._closing = False
        try:
            await self.recover_stale(include_own_host=True)
        except Exception:  # noqa: BLE001 - recovery must never stop the API booting
            logger.exception("recovering stale revisions failed")
        if self._sweeper is None or self._sweeper.done():
            self._sweeper = asyncio.create_task(self._sweep_loop(), name="revision-sweeper")

    async def aclose(self) -> None:
        """Stop the sweeper, cancel every job (their suggestions become failed
        `interrupted`), close the client pool. No task outlives this call."""
        self._closing = True
        if self._sweeper is not None:
            self._sweeper.cancel()
            await asyncio.gather(self._sweeper, return_exceptions=True)
            self._sweeper = None
        tasks = [t for t in self._tasks.values() if not t.done()]
        for comment_id, task in list(self._tasks.items()):
            if not task.done():
                self._reasons[comment_id] = "interrupted"
                task.cancel()
        if tasks:
            await asyncio.wait(tasks, timeout=10)
        # Nothing may write to the database after the engine is disposed: give
        # the outcome-recording tasks a last moment, then cancel what is left.
        leftover = [t for t in self._records if not t.done()]
        if leftover:
            _done, pending = await asyncio.wait(leftover, timeout=5)
            for task in pending:
                logger.warning("a revision outcome was still being recorded at shutdown; cancelling it")
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
        self._tasks.clear()
        if self._pool is not None:
            pool, self._pool = self._pool, None
            try:
                await pool.aclose()
            except Exception:  # noqa: BLE001
                logger.exception("closing the revision client pool failed")

    async def _sweep_loop(self) -> None:
        while True:
            await asyncio.sleep(self._sweep_interval_s)
            try:
                await self.sweep_once()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.exception("revision sweeper pass failed")

    async def sweep_once(self) -> None:
        """One housekeeping pass: fail jobs whose owner died, drop the progress
        events and job rows of long finished suggestions."""
        await self.recover_stale()
        async with self._session_factory() as session:
            repo = SqlAlchemyRevisionRepository(session)
            await repo.purge_finished(self._settings.revision_events_keep_s)
            await repo.commit()

    async def recover_stale(
        self, *, max_age_s: float | None = None, include_own_host: bool = False
    ) -> int:
        """Mark `running` suggestions whose job is not alive `failed` /
        `interrupted`: heartbeat older than `max_age_s` (default
        `REVISION_STALE_S`) or no job row, and - on startup - owned by another
        process of this host (this process is the only one that can be)."""
        max_age = self._settings.revision_stale_s if max_age_s is None else max_age_s
        async with self._session_factory() as session:
            ids = await SqlAlchemyRevisionRepository(session).stale_running(
                max_age,
                owner_prefix=f"{self.hostname}:" if include_own_host else None,
                exclude_owner=self.instance_id,
            )
        count = 0
        for comment_id in ids:
            if comment_id in self._tasks and not self._tasks[comment_id].done():
                continue
            if await self._finish(
                comment_id, "failed", error=("interrupted", ERROR_MESSAGES["interrupted"]), usage={}
            ):
                count += 1
        return count

    # ------------------------------------------------------------- llm
    def llm_settings(self, *, model: str | None, api_key: str | None) -> LLMSettings:
        """The settings a run on this deployment would use (environment
        endpoint and key, the project's model), unless the user stored their own
        key. The environment key is never sent to a different endpoint (the
        engine enforces it; there is no per-project endpoint here)."""
        # The environment's reasoning effort (prod sets "none") applies to
        # revisions too, else the model's default reasoning would eat the 90 s
        # interactive timeout. A malformed value falls back to "not sent".
        env = os.environ if self._env is None else self._env
        effort = (env.get("AUTOGENBOOK_LLM_REASONING_EFFORT") or "").strip().lower() or None
        try:
            return interactive_llm_settings(
                self._env, model=model, api_key=api_key, reasoning_effort=effort
            )
        except ConfigError:
            return interactive_llm_settings(self._env, model=model, api_key=api_key)

    # ------------------------------------------------------------- jobs
    def spawn(self, job: RevisionJob) -> asyncio.Task:
        task = asyncio.create_task(self._run(job), name=f"revision-{job.comment_id}")
        self._tasks[job.comment_id] = task
        task.add_done_callback(lambda _t, cid=job.comment_id: self._forget(cid))
        return task

    def _forget(self, comment_id: uuid.UUID) -> None:
        self._tasks.pop(comment_id, None)
        self._reasons.pop(comment_id, None)

    def owns(self, comment_id: uuid.UUID) -> bool:
        task = self._tasks.get(comment_id)
        return task is not None and not task.done()

    async def cancel_local(self, comment_id: uuid.UUID, *, timeout_s: float = 5.0) -> bool:
        """Cancel the job if this process owns it and wait (briefly) for it to
        record the outcome; False when it runs elsewhere (or not at all)."""
        task = self._tasks.get(comment_id)
        if task is None or task.done():
            return False
        self._reasons[comment_id] = "cancelled"
        task.cancel()
        await asyncio.wait({task}, timeout=timeout_s)
        return True

    async def wait_idle(self, timeout_s: float = 10.0) -> None:
        """Wait for the running jobs to finish (tests, graceful drains)."""
        tasks = [t for t in self._tasks.values() if not t.done()]
        if tasks:
            await asyncio.wait(tasks, timeout=timeout_s)

    # ---------------------------------------------------------- the job
    async def _run(self, job: RevisionJob) -> None:
        comment_id = job.comment_id
        sink = DbEventSink()
        started = _now()
        work = asyncio.create_task(self._work(job, sink), name=f"revise-{comment_id}")
        flusher = asyncio.create_task(self._flush_loop(job, sink, work), name=f"flush-{comment_id}")
        # The outcome is defaulted before anything is awaited, so a cancel at
        # any point (even a second one while the work unwinds) still records
        # something meaningful, and everything after the work is torn down and
        # recorded inside the shield.
        outcome: tuple[str, dict[str, Any]] = (
            "failed",
            {"error": ("internal", ERROR_MESSAGES["internal"])},
        )
        try:
            try:
                await asyncio.wait({work}, timeout=self._settings.revision_timeout_s)
            except asyncio.CancelledError:
                outcome = (
                    self._reasons.setdefault(comment_id, "cancelled"),
                    {"usage": dict(sink.last_usage)},
                )
                work.cancel()
                await self._drain(work)
                # a result that was already there wins over the cancel
                if work.done() and not work.cancelled() and work.exception() is None:
                    outcome = ("pending", {"result": work.result()})
            else:
                if not work.done():
                    code, _message, usage = map_error(asyncio.TimeoutError())
                    message = (
                        f"The revision did not finish within "
                        f"{int(self._settings.revision_timeout_s)} seconds."
                    )
                    outcome = (
                        "failed",
                        {"error": (code, message), "usage": usage or dict(sink.last_usage)},
                    )
                    work.cancel()
                    await self._drain(work)
                else:
                    outcome = self._classify(comment_id, work, sink)
        finally:
            await self._shielded(self._teardown_and_record(job, sink, flusher, outcome, started))

    @staticmethod
    async def _drain(task: asyncio.Task) -> None:
        """Wait for `task` to finish, whatever else cancels the caller meanwhile."""
        while not task.done():
            try:
                await asyncio.wait({task})
            except asyncio.CancelledError:
                continue

    def _classify(
        self, comment_id: uuid.UUID, work: asyncio.Task, sink: DbEventSink
    ) -> tuple[str, dict[str, Any]]:
        if work.cancelled():
            return (self._reasons.get(comment_id, "external"), {"usage": dict(sink.last_usage)})
        exc = work.exception()
        if exc is not None:
            code, message, usage = map_error(exc)
            if code == "internal":
                logger.error("revision %s failed", comment_id, exc_info=exc)
            return ("failed", {"error": (code, message), "usage": usage or dict(sink.last_usage)})
        return ("pending", {"result": work.result()})

    async def _teardown_and_record(
        self,
        job: RevisionJob,
        sink: DbEventSink,
        flusher: asyncio.Task,
        outcome: tuple[str, dict[str, Any]],
        started: datetime,
    ) -> None:
        flusher.cancel()
        await asyncio.gather(flusher, return_exceptions=True)
        await self._record(job, sink, outcome, started)

    async def _shielded(self, coro) -> None:
        """Run `coro` as its own task and wait for it even if this task is
        cancelled (once or repeatedly); the cancel is re-raised afterwards."""
        task = asyncio.ensure_future(coro)
        self._records.add(task)
        task.add_done_callback(self._records.discard)
        cancelled = False
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                if task.cancelled():
                    break
                cancelled = True
        if cancelled:
            raise asyncio.CancelledError
        if not task.cancelled():
            task.result()

    async def _record(
        self,
        job: RevisionJob,
        sink: DbEventSink,
        outcome: tuple[str, dict[str, Any]] | None,
        started: datetime,
    ) -> None:
        comment_id = job.comment_id
        try:
            await self._flush(job, sink)
        except Exception:  # noqa: BLE001 - a lost event must never lose the outcome
            logger.exception("final event flush of revision %s failed", comment_id)
        kind, data = outcome or ("failed", {"error": ("internal", ERROR_MESSAGES["internal"])})
        try:
            if kind == "pending":
                await self._finish_pending(job, data["result"], started)
            elif kind == "failed":
                await self._finish(
                    comment_id, "failed", error=data["error"], usage=data.get("usage") or {}
                )
            elif kind == "interrupted":
                await self._finish(
                    comment_id,
                    "failed",
                    error=("interrupted", ERROR_MESSAGES["interrupted"]),
                    usage=data.get("usage") or {},
                )
            else:  # cancelled here, or by someone else (external)
                await self._finish(comment_id, "cancelled", usage=data.get("usage") or {})
        except Exception:  # noqa: BLE001
            logger.exception("recording the outcome of revision %s failed", comment_id)

    async def _work(self, job: RevisionJob, sink: DbEventSink):
        request = job.request
        if job.retrieval_dir is not None:
            try:
                retrieval = await load_revision_retrieval(
                    job.retrieval_dir, kb_sources=job.kb_sources
                )
            except Exception:  # noqa: BLE001 - no retrieval is better than no revision
                logger.exception("loading the knowledge base for revision %s failed", job.comment_id)
                retrieval = None
            if retrieval is not None:
                request = dataclasses.replace(request, retrieval=retrieval)
        return await self.pool.revise(request, sink)

    async def _flush(self, job: RevisionJob, sink: DbEventSink, *, heartbeat: bool = True) -> None:
        events = sink.drain()
        async with self._session_factory() as session:
            repo = SqlAlchemyRevisionRepository(session)
            if events:
                seq = await repo.max_seq(job.comment_id)
                await repo.append_events(
                    job.comment_id,
                    [
                        RevisionEvent(
                            seq=seq + i,
                            ts=e["ts"],
                            level=e["level"],
                            stage=e["stage"],
                            message=e["message"],
                            payload=e["payload"],
                        )
                        for i, e in enumerate(events, start=1)
                    ],
                )
            if heartbeat:
                await repo.heartbeat(job.comment_id)
            await session.commit()

    async def _flush_loop(self, job: RevisionJob, sink: DbEventSink, work: asyncio.Task) -> None:
        """Every poll interval: persist the buffered events, refresh the
        heartbeat, and look at the row - a status other than `running` (a
        cancel from any replica) or a deleted row stops the work."""
        last_beat = 0.0
        loop = asyncio.get_running_loop()
        while not work.done():
            await asyncio.sleep(self._poll_interval_s)
            try:
                beat = loop.time() - last_beat >= self._settings.revision_heartbeat_s
                await self._flush(job, sink, heartbeat=beat)
                if beat:
                    last_beat = loop.time()
                async with self._session_factory() as session:
                    status, deleted, cancel = await SqlAlchemyRevisionRepository(session).poll(
                        job.comment_id
                    )
                if deleted or cancel or status != CommentStatus.RUNNING:
                    self._reasons.setdefault(job.comment_id, "external")
                    work.cancel()
                    return
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - a database hiccup must not kill the job
                logger.exception("flushing revision %s failed", job.comment_id)

    # ---------------------------------------------------------- outcomes
    async def _finish_pending(self, job: RevisionJob, result: Any, started: datetime) -> None:
        payload = {
            **job.base_payload,
            "originalMarkdown": result.original_markdown,
            "replacementMarkdown": result.replacement_markdown,
            "hunks": [h.to_dict() for h in result.hunks],
            "summary": result.summary,
            "changesMade": list(result.changes_made),
            "warnings": [*job.extra_warnings, *result.warnings],
            "droppedCitations": list(result.dropped_citations),
            "anchor": result.anchor,
            "model": result.model,
            "usage": _json_safe(result.usage),
            "startedAt": _iso(started),
            "finishedAt": _iso(_now()),
        }
        async with self._session_factory() as session:
            comments = _comments(session)
            ok = await comments.transition_suggestion(
                job.comment_id,
                CommentStatus.RUNNING,
                status=CommentStatus.PENDING,
                payload=payload,
                body_markdown=(result.summary or "")[:20_000],
            )
        if ok:
            await self._drop_job(job.comment_id)
        else:
            # Cancelled / deleted meanwhile: the result is discarded; a deleted
            # card must still end in a terminal state.
            logger.info("revision %s finished but was no longer running; result discarded", job.comment_id)
            await self._finish(job.comment_id, "cancelled", usage=_json_safe(result.usage))

    async def _drop_job(self, comment_id: uuid.UUID) -> None:
        """The job row only matters while the suggestion runs."""
        try:
            async with self._session_factory() as session:
                repo = SqlAlchemyRevisionRepository(session)
                await repo.delete_job(comment_id)
                await repo.commit()
        except Exception:  # noqa: BLE001 - the sweeper removes it later
            logger.warning("could not delete the job row of revision %s", comment_id)

    async def _finish(
        self,
        comment_id: uuid.UUID,
        outcome: Literal["failed", "cancelled"],
        *,
        error: tuple[str, str] | None = None,
        usage: dict[str, Any],
    ) -> bool:
        """CAS `running -> failed|cancelled`, keeping the request echo in the
        payload. If somebody cancelled first, only the usage is added."""
        async with self._session_factory() as session:
            comments = _comments(session)
            row = await comments.get(comment_id, include_deleted=True)
            if row is None or row.kind != CommentKind.SUGGESTION:
                return False
            payload = {**row.payload, "finishedAt": _iso(_now())}
            if usage:
                payload["usage"] = _json_safe(usage)
            if error is not None:
                payload["error"] = {"code": error[0], "message": error[1]}
            target = CommentStatus.FAILED if outcome == "failed" else CommentStatus.CANCELLED
            if await comments.transition_suggestion(
                comment_id,
                CommentStatus.RUNNING,
                status=target,
                payload=payload,
                include_deleted=True,
            ):
                await self._drop_job(comment_id)
                return True
            if row.status == CommentStatus.CANCELLED and usage and "usage" not in row.payload:
                await comments.transition_suggestion(
                    comment_id,
                    CommentStatus.CANCELLED,
                    status=CommentStatus.CANCELLED,
                    payload={**row.payload, "usage": _json_safe(usage)},
                    include_deleted=True,
                )
            return False


def _comments(session: AsyncSession) -> CommentRepository:
    from api.infrastructure.db.comment_repository import SqlAlchemyCommentRepository

    return SqlAlchemyCommentRepository(session)


# ------------------------------------------------------------------ service
@dataclass
class StartedRevision:
    kind: Literal["suggestion", "run"]
    suggestion: NodeComment | None = None
    run: Run | None = None


@dataclass
class RevisionParamsData:
    more_proofs: bool = False
    more_examples: bool = False
    more_rigorous: bool = False
    shorter: bool = False
    longer: bool = False
    cite_sources: bool = False
    fix_issue_ids: tuple[uuid.UUID, ...] = ()
    address_comment_ids: tuple[uuid.UUID, ...] = ()

    @property
    def has_any(self) -> bool:
        return bool(
            self.more_proofs or self.more_examples or self.more_rigorous or self.shorter
            or self.longer or self.cite_sources or self.fix_issue_ids or self.address_comment_ids
        )

    def to_payload(self) -> dict[str, Any]:
        return {
            "moreProofs": self.more_proofs,
            "moreExamples": self.more_examples,
            "moreRigorous": self.more_rigorous,
            "shorter": self.shorter,
            "longer": self.longer,
            "citeSources": self.cite_sources,
            "fixIssueIds": [str(i) for i in self.fix_issue_ids],
            "addressCommentIds": [str(i) for i in self.address_comment_ids],
        }


def _is_running_index_violation(exc: IntegrityError) -> bool:
    """Only the one-running-revision-per-node unique index means "already
    running" (Postgres names it; SQLite names the column)."""
    text = str(exc.orig) if exc.orig is not None else str(exc)
    return "uq_node_comments_running_suggestion" in text or "node_comments.node_id" in text


def _word_count(text: str) -> int:
    return len(text.split())


class RevisionService:
    def __init__(
        self,
        *,
        comment_repository: CommentRepository,
        outline_repository: OutlineRepository,
        project_repository: ProjectRepository,
        run_repository: RunRepository,
        user_repository: UserRepository,
        revision_repository: SqlAlchemyRevisionRepository,
        run_service: Any,
        runner: RevisionRunner,
        settings: Settings,
    ) -> None:
        self._comments = comment_repository
        self._outline = outline_repository
        self._projects = project_repository
        self._runs = run_repository
        self._users = user_repository
        self._revisions = revision_repository
        self._run_service = run_service
        self._runner = runner
        self._settings = settings

    # ------------------------------------------------------------ lookup
    async def _node(self, project_id: uuid.UUID, node_id: uuid.UUID) -> tuple[Project, OutlineNode]:
        project = await self._projects.get(project_id)
        if project is None:
            raise NotFound(f"project {project_id} does not exist")
        node = await self._outline.get(node_id)
        if node is None or node.project_id != project_id:
            raise NotFound(f"outline node {node_id} does not exist")
        return project, node

    async def get_suggestion(self, suggestion_id: uuid.UUID) -> NodeComment:
        row = await self._comments.get(suggestion_id)
        if row is None or row.kind != CommentKind.SUGGESTION:
            raise NotFound(f"suggestion {suggestion_id} does not exist")
        return row

    # ------------------------------------------------------------- start
    async def start(
        self,
        project_id: uuid.UUID,
        node_id: uuid.UUID,
        user: User,
        *,
        verb: Verb,
        scope: Scope,
        anchor: dict[str, Any] | None,
        instruction: str,
        params: RevisionParamsData,
        thread_id: uuid.UUID | None,
    ) -> StartedRevision:
        project, node = await self._node(project_id, node_id)
        instruction = instruction.replace("\x00", "").strip()
        if len(instruction) > self._settings.revision_max_instruction_chars:
            raise ValidationFailed(
                f"instruction is longer than {self._settings.revision_max_instruction_chars} characters"
            )
        if verb == "rewrite":
            return await self._start_rewrite(
                project_id, node_id, user, scope=scope, anchor=anchor, instruction=instruction,
                params=params, thread_id=thread_id,
            )

        # ---- validation (cheap, no side effects)
        if params.shorter and params.longer:
            raise ValidationFailed("params.shorter and params.longer cannot both be set")
        if not (instruction or params.has_any or thread_id is not None):
            raise ValidationFailed("give an instruction or at least one parameter")
        if node.status == NodeStatus.DRAFTING:
            raise Conflict(
                "this section is being generated by a run; wait for it to finish",
                code="node_generating",
            )
        content = node.content_markdown or ""
        if not content.strip():
            raise Conflict("this section has no text to revise yet", code="section_empty")
        if scope == "section" and len(content) > self._settings.revision_max_section_chars:
            raise Conflict(
                f"this section is too long to revise as a whole "
                f"({len(content)} > {self._settings.revision_max_section_chars} characters); "
                "select the passage to revise instead",
                code="section_too_large",
            )

        thread_root = await self._load_thread_root(node, thread_id)
        fix_rows, address_rows = await self._load_references(node, params, thread_root)

        resolved_anchor: dict[str, Any] | None = None
        if scope == "range":
            candidate = anchor if anchor is not None else (thread_root.anchor if thread_root else None)
            if candidate is None:
                raise ValidationFailed("a range revision needs an anchor (or a threadId with one)")
            quote = str(candidate.get("quote") or "")
            c_start, c_end = candidate.get("start"), candidate.get("end")
            if (
                isinstance(c_start, int) and isinstance(c_end, int)
                and not isinstance(c_start, bool) and not isinstance(c_end, bool)
                and 0 <= c_start < c_end <= len(content) and content[c_start:c_end] == quote
            ):
                # Exact client offsets that really hold the quote are the
                # selection (the server computes the context): this is what
                # disambiguates a repeated quote.
                resolved, level = make_anchor(content, c_start, c_end), "stored"
            else:
                resolved, level = await run_in_threadpool(resolve_anchor_level, content, candidate)
            if resolved.get("start") is None or level not in ACCEPTED_LEVELS:
                raise Conflict(
                    "the selected text no longer matches the section; select it again",
                    code="anchor_orphaned",
                )
            resolved_anchor = resolved
        elif anchor is not None:
            raise ValidationFailed("an anchor is only meaningful for scope 'range'")

        await self._check_caps(node, user)
        llm = await self._llm_settings(project, user)

        flat = await self._outline.list(project_id)
        brief = self._brief(project, node, flat)
        retrieval_dir, retrieval_warnings = await self._retrieval_dir(project)
        kb_sources = self._effective_kb_sources(node, flat)

        fix_issues = tuple(self._issue_dict(r) for r in fix_rows)
        address_texts = tuple(await self._thread_texts(address_rows))
        request = ReviseRequest(
            body_markdown=content,
            instruction=instruction,
            scope=scope,
            anchor=resolved_anchor,
            params=ReviseParams(
                more_proofs=params.more_proofs,
                more_examples=params.more_examples,
                more_rigorous=params.more_rigorous,
                shorter=params.shorter,
                longer=params.longer,
                cite_sources=params.cite_sources,
                fix_issues=fix_issues,
                address_comments=address_texts,
            ),
            brief=brief,
            llm=llm,
        )

        # ---- create the card and the job row in one transaction
        comment_id = uuid.uuid4()
        now = _now()
        base_payload = {
            "verb": "revise",
            "scope": scope,
            "instruction": instruction,
            "params": params.to_payload(),
            "threadId": str(thread_root.id) if thread_root else None,
            "baseContentHash": content_hash(content),
            # Was the selected text the only copy of itself? (decides whether a
            # lone remaining copy may stand in for it later; see
            # `suggestion_anchor_accepted`)
            "anchorUnique": bool(resolved_anchor) and content.count(resolved_anchor["quote"]) == 1,
            "model": llm.model,
            "startedAt": _iso(now),
        }
        row = NodeComment(
            id=comment_id,
            project_id=project_id,
            node_id=node_id,
            kind=CommentKind.SUGGESTION,
            author_id=user.id,
            anchor=resolved_anchor,
            status=CommentStatus.RUNNING,
            thread_id=thread_root.id if thread_root else comment_id,
            parent_id=thread_root.id if thread_root else None,
            body_markdown="",
            payload=base_payload,
            created_at=now,
            updated_at=now,
            author_name=user.display_name,
        )
        try:
            created = await self._comments.add(row, commit=False)
            await self._revisions.add_job(comment_id, self._runner.instance_id)
            await self._revisions.commit()
        except IntegrityError as exc:
            await self._revisions.rollback()
            if _is_running_index_violation(exc):
                raise Conflict(
                    "a revision of this section is already running", code="revision_in_progress"
                ) from exc
            raise
        except BaseException:
            await self._revisions.rollback()
            raise
        self._runner.spawn(
            RevisionJob(
                comment_id=comment_id,
                project_id=project_id,
                node_id=node_id,
                request=request,
                base_payload=base_payload,
                retrieval_dir=retrieval_dir,
                kb_sources=kb_sources,
                extra_warnings=retrieval_warnings,
            )
        )
        return StartedRevision(kind="suggestion", suggestion=created)

    async def queue_position(self, run: Run) -> int | None:
        return await self._run_service.queue_position(run)

    async def _start_rewrite(
        self,
        project_id: uuid.UUID,
        node_id: uuid.UUID,
        user: User,
        *,
        scope: Scope,
        anchor: dict[str, Any] | None,
        instruction: str,
        params: RevisionParamsData,
        thread_id: uuid.UUID | None,
    ) -> StartedRevision:
        """Rewrite stays on the regenerate run (`RunService.regenerate_node`):
        same preconditions, same 409s; the instruction is the run's prompt
        modifier. Revision-only inputs are refused instead of silently dropped."""
        if scope != "section" or anchor is not None:
            raise ValidationFailed("rewrite applies to the whole section (scope 'section', no anchor)")
        if params.has_any or thread_id is not None:
            raise ValidationFailed("rewrite takes an instruction only (no params, no threadId)")
        run = await self._run_service.regenerate_node(
            project_id, node_id, prompt_modifier=instruction or None, started_by=user.id
        )
        return StartedRevision(kind="run", run=run)

    # ---------------------------------------------------------- start: parts
    async def _load_thread_root(
        self, node: OutlineNode, thread_id: uuid.UUID | None
    ) -> NodeComment | None:
        if thread_id is None:
            return None
        root = await self._comments.get(thread_id)
        if (
            root is None
            or root.node_id != node.id
            or root.parent_id is not None
            or root.kind not in (CommentKind.COMMENT, CommentKind.REVIEW)
        ):
            raise ValidationFailed(f"threadId {thread_id} is not a comment thread of this section")
        return root

    async def _load_references(
        self, node: OutlineNode, params: RevisionParamsData, thread_root: NodeComment | None
    ) -> tuple[list[NodeComment], list[NodeComment]]:
        """The review rows to fix and the comment roots to address, all checked
        to be live roots of this node. The thread the suggestion lives in counts
        as a reference of its own kind."""
        fix_ids = list(dict.fromkeys(params.fix_issue_ids))
        address_ids = list(dict.fromkeys(params.address_comment_ids))
        if thread_root is not None:
            (fix_ids if thread_root.kind == CommentKind.REVIEW else address_ids).append(thread_root.id)
            fix_ids, address_ids = list(dict.fromkeys(fix_ids)), list(dict.fromkeys(address_ids))
        if len(address_ids) > MAX_THREADS_PER_REVISION or len(fix_ids) > MAX_THREADS_PER_REVISION:
            raise ValidationFailed(f"at most {MAX_THREADS_PER_REVISION} issues/comments per revision")
        found = {r.id: r for r in await self._comments.get_many([*fix_ids, *address_ids])}

        def pick(ids: list[uuid.UUID], kind: CommentKind, label: str) -> list[NodeComment]:
            rows = []
            for comment_id in ids:
                row = found.get(comment_id)
                if row is None or row.node_id != node.id or row.parent_id is not None or row.kind != kind:
                    raise ValidationFailed(f"{label} {comment_id} is not a {kind.value} of this section")
                rows.append(row)
            return rows

        return (
            pick(fix_ids, CommentKind.REVIEW, "fixIssueIds entry"),
            pick(address_ids, CommentKind.COMMENT, "addressCommentIds entry"),
        )

    @staticmethod
    def _issue_dict(row: NodeComment) -> dict[str, Any]:
        payload = row.payload
        issue: dict[str, Any] = {
            "type": payload.get("type") or "other",
            "severity": payload.get("severity") or "minor",
            "description": row.body_markdown,
            "required_fix": payload.get("requiredFix") or "",
        }
        quote = (row.anchor or {}).get("quote") or payload.get("quote") or ""
        if quote:
            issue["quote"] = quote
        if payload.get("replaceFrom"):
            issue["replace_from"] = payload["replaceFrom"]
            issue["replace_to"] = payload.get("replaceTo") or ""
        return issue

    async def _thread_texts(self, roots: list[NodeComment]) -> list[str]:
        if not roots:
            return []
        rows = await self._comments.list_threads([r.id for r in roots])
        by_thread: dict[uuid.UUID, list[NodeComment]] = {}
        for row in rows:
            by_thread.setdefault(row.thread_id, []).append(row)
        texts = []
        for root in roots:
            thread = sorted(by_thread.get(root.id, [root]), key=lambda c: (c.created_at, c.id))
            head = ""
            quote = (root.anchor or {}).get("quote")
            if quote:
                head = f'On the passage "{quote[:300]}": '
            body = " / ".join(f"{c.author_name or 'Colleague'}: {c.body_markdown}" for c in thread)
            texts.append((head + body)[:MAX_THREAD_CHARS])
        return texts

    async def _check_caps(self, node: OutlineNode, user: User) -> None:
        # Per-user admission is serialised on the user's row, held until the
        # suggestion row is committed, so simultaneous starts cannot all pass
        # the count.
        await self._revisions.lock_user(user.id)
        if await self._comments.count_running_suggestions(node_id=node.id):
            raise Conflict(
                "a revision of this section is already running; cancel it or wait for it",
                code="revision_in_progress",
            )
        if (
            await self._comments.count_running_suggestions(author_id=user.id)
            >= self._settings.revision_max_per_user
        ):
            raise TooManyRequests(
                f"you already have {self._settings.revision_max_per_user} revisions running; "
                "wait for one to finish",
                code="too_many_revisions",
            )

    async def _llm_settings(self, project: Project, user: User) -> LLMSettings:
        """The model, endpoint and key a run of this project would use: the
        project's model, the deployment endpoint, the user's own key when they
        stored one (policy `required` makes that mandatory), else the deployment
        key. Never reads a key from the request."""
        api_key: str | None = None
        cipher = LlmKeyCipher.from_settings(self._settings)
        if cipher is not None:
            stored = await self._users.get_by_id(user.id)
            encrypted = stored.llm_api_key_encrypted if stored is not None and stored.is_active else None
            if encrypted:
                try:
                    api_key = cipher.decrypt(encrypted)
                except LlmKeyDecryptError as exc:
                    raise Conflict(
                        "Your stored LLM API key could not be decrypted; set your key again in "
                        "your account settings",
                        code=LLM_KEY_REQUIRED_CODE,
                    ) from exc
            elif self._settings.llm_key_policy == "required":
                raise Conflict(LLM_KEY_REQUIRED_MESSAGE, code=LLM_KEY_REQUIRED_CODE)
        try:
            llm = self._runner.llm_settings(model=project.llm_model, api_key=api_key)
        except ReviseConfigError as exc:
            raise Conflict(str(exc), code="llm_not_configured") from exc
        if not llm.api_key and is_openrouter(llm.base_url):
            raise Conflict(
                "no LLM API key is configured for this deployment (set OPENROUTER_API_KEY or "
                "add your own key in your account settings)",
                code="llm_not_configured",
            )
        return llm

    def _brief(self, project: Project, node: OutlineNode, flat: list[OutlineNode]) -> SectionBrief:
        positioned = assign_positions(flat)
        ordered: list[OutlineNode] = []

        def walk(trees) -> None:
            for tree in trees:
                ordered.append(tree.node)
                walk(tree.children)

        walk(build_tree(positioned))
        index = next((i for i, n in enumerate(ordered) if n.id == node.id), 0)
        lo, hi = max(0, index - 30), min(len(ordered), index + 31)
        lines = []
        for n in ordered[lo:hi]:
            mark = "   <-- this section" if n.id == node.id else ""
            lines.append(f"{'  ' * max(n.level - 1, 0)}{n.section_number} {n.title}{mark}")
        outline = "\n".join(lines)[:4000]

        def gist(n: OutlineNode) -> str:
            text = (n.summary or "").strip() or " ".join((n.content_markdown or "").split())
            return f"{n.section_number} {n.title}: {text[:400]}".strip()

        neighbours = []
        if index > 0:
            neighbours.append("Previous section - " + gist(ordered[index - 1]))
        if index + 1 < len(ordered):
            neighbours.append("Next section - " + gist(ordered[index + 1]))
        density = node.equation_density_level
        return SectionBrief(
            title=node.title,
            summary=node.summary or "",
            book_title=project.title,
            target_readers=getattr(project.target_audience, "value", str(project.target_audience)),
            document_kind="book",
            language=None,
            target_pages=node.target_pages,
            equation_density=density if isinstance(density, int) and 1 <= density <= 5 else None,
            math_level=getattr(node.math_level, "value", str(node.math_level or "")),
            sub_prompt=node.sub_prompt or "",
            outline=outline,
            neighbours="\n".join(neighbours),
        )

    @staticmethod
    def _effective_kb_sources(node: OutlineNode, flat: list[OutlineNode]) -> tuple[str, ...] | None:
        """The node's effective source restriction (nearest explicit scope up the
        tree, like the engine's `resolve_kb_sources`): None = every source."""
        by_id = {n.id: n for n in flat}
        current: OutlineNode | None = node
        seen: set[uuid.UUID] = set()
        while current is not None and current.id not in seen:
            seen.add(current.id)
            scope = getattr(current.source_scope, "value", current.source_scope)
            if scope == "all":
                return None
            if scope == "selected":
                return tuple(str(s) for s in current.source_ids)
            current = by_id.get(current.parent_id) if current.parent_id else None
        return None

    async def _retrieval_dir(self, project: Project) -> tuple[Path | None, tuple[str, ...]]:
        """`(work dir, warnings)`: the work directory of the project's most
        recent succeeded run that built a knowledge base (full and regenerate
        runs only - a burst of exports must not hide it) and saved its index,
        derived from the database and required to lie under `RUNS_DIR`, never
        from the request. `(None, ...)` = no retrieval; a saved index larger
        than `REVISION_MAX_KB_BYTES` is not loaded into the API process (a
        warning says so)."""
        runs, _total = await self._runs.list(
            project.id,
            limit=10,
            offset=0,
            statuses=[RunStatus.succeeded],
            kinds=[RunKind.full, RunKind.regenerate_section],
        )
        runs_root = await run_in_threadpool(lambda: Path(self._settings.runs_dir).resolve())
        limit = self._settings.revision_max_kb_bytes

        def usable(run: Run) -> tuple[Path | None, bool]:
            try:
                work_dir = Path(run.work_dir).resolve()
            except OSError:
                return None, False
            if runs_root != work_dir and runs_root not in work_dir.parents:
                return None, False
            cache = work_dir / book_command.OUT_DIRNAME / ".kb_cache"
            if not cache.is_dir():
                return None, False
            size = 0
            for index in cache.glob("engine_kb_*.pkl"):
                try:
                    size = max(size, index.stat().st_size)
                except OSError:
                    continue
            if size > limit:
                return None, True
            return work_dir, False

        for run in runs:
            found, too_large = await run_in_threadpool(usable, run)
            if too_large:
                return None, ("sources too large to search during a revision",)
            if found is not None:
                return found, ()
        return None, ()

    # ------------------------------------------------------------ accept
    async def accept(
        self,
        suggestion_id: uuid.UUID,
        user: User,
        *,
        hunk_indexes: list[int] | None = None,
        expected_content_hash: str | None = None,
    ) -> NodeComment:
        """Apply a `pending` suggestion to the node's text (see
        `revision_apply`), in one transaction with: the status change, the
        resolution of the threads/issues it addressed, and the re-anchoring of
        the node's other cards. Locks the node row first (the content PATCH
        takes the same lock, in the same order), so it cannot interleave with
        another accept or a save; `expected_content_hash` (the client's
        `contentHash` of the text it shows) makes it fail with `content_conflict`
        instead of applying to text the client has not seen. The addressed
        threads/issues are settled only by a full accept, not by a partial one."""
        row = await self.get_suggestion(suggestion_id)
        if row.status != CommentStatus.PENDING:
            raise Conflict(
                f"this suggestion is {row.status.value}; only a pending one can be accepted",
                code="not_pending",
            )
        hunk_count = len(row.payload.get("hunks") or [])
        if hunk_indexes is not None:
            if not hunk_indexes:
                raise ValidationFailed("hunkIndexes must not be empty")
            if row.payload.get("scope") != "section":
                raise ValidationFailed("hunkIndexes apply to section suggestions only")
            if len(set(hunk_indexes)) != len(hunk_indexes):
                raise ValidationFailed("hunkIndexes must not repeat an index")
            if any(not 0 <= i < hunk_count for i in hunk_indexes):
                raise ValidationFailed(f"hunkIndexes must be between 0 and {hunk_count - 1}")
        try:
            node = await self._outline.get_for_update(row.node_id)
            if node is None:
                raise NotFound(f"outline node {row.node_id} does not exist")
            # Re-read under the lock: a concurrent accept/reject/cancel may have
            # won, and the anchor may have been re-anchored since the first read.
            current_row = await self._comments.get(suggestion_id)
            if current_row is None or current_row.kind != CommentKind.SUGGESTION:
                raise NotFound(f"suggestion {suggestion_id} does not exist")
            row = current_row
            if row.status != CommentStatus.PENDING:
                raise Conflict(
                    f"this suggestion is {row.status.value}; only a pending one can be accepted",
                    code="not_pending",
                )
            if expected_content_hash is not None and expected_content_hash != content_hash(
                node.content_markdown or ""
            ):
                raise Conflict(
                    "the section changed since you loaded it; reload it before accepting",
                    code="content_conflict",
                    extensions={"currentContentHash": content_hash(node.content_markdown or "")},
                )
            if node.status == NodeStatus.DRAFTING:
                raise Conflict(
                    "this section is being generated by a run; its text would be overwritten",
                    code="node_generating",
                )
            if not node.content_locked:
                lane = await self._runs.list_active_for_project(node.project_id)
                if any(r.kind == RunKind.full for r in lane):
                    raise Conflict(
                        "a full run is active and would overwrite this section; accept after it "
                        "finishes (or lock the section's content first)",
                        code="run_active",
                    )
            try:
                new_content = apply_revision(
                    node.content_markdown or "", row.payload, row.anchor, hunk_indexes
                )
            except StaleSuggestion as exc:
                raise Conflict(str(exc), code="stale") from exc
            except MalformedSuggestion as exc:
                raise Conflict(str(exc), code="invalid_suggestion") from exc

            now = _now()
            payload = {
                **row.payload,
                "acceptedAt": _iso(now),
                "acceptedBy": str(user.id),
                "appliedHunks": sorted(set(hunk_indexes)) if hunk_indexes is not None else None,
            }
            if not await self._comments.transition_suggestion(
                suggestion_id,
                CommentStatus.PENDING,
                status=CommentStatus.ACCEPTED,
                payload=payload,
                commit=False,
            ):
                raise Conflict("this suggestion is no longer pending", code="not_pending")

            fields = ["content_markdown", "actual_words"]
            changes: dict[str, Any] = {
                "content_markdown": new_content,
                "actual_words": _word_count(new_content),
            }
            if node.content_locked and not new_content.strip():
                changes["content_locked"] = False  # like a content PATCH that blanks a locked node
                fields.append("content_locked")
            await self._outline.update(
                dataclasses.replace(node, **changes, updated_at=now), fields=tuple(fields), commit=False
            )

            full = hunk_indexes is None or len(set(hunk_indexes)) == hunk_count
            if full:
                await self._comments.set_status_many(
                    await self._resolvable_references(row, node), CommentStatus.RESOLVED
                )
            await reanchor_node_cards(self._comments, node.id, new_content)
            await self._outline.commit()
        except BaseException:
            await self._outline.rollback()
            raise
        return await self.get_suggestion(suggestion_id)

    async def _resolvable_references(self, row: NodeComment, node: OutlineNode) -> list[uuid.UUID]:
        """Roots the accepted suggestion settles: the thread it lives in, the
        review rows it fixed and the comment threads it addressed."""
        params = row.payload.get("params") or {}
        ids: list[uuid.UUID] = []
        for raw in [*(params.get("fixIssueIds") or []), *(params.get("addressCommentIds") or [])]:
            try:
                ids.append(uuid.UUID(str(raw)))
            except ValueError:
                continue
        if row.parent_id is not None:
            ids.append(row.thread_id)
        if not ids:
            return []
        rows = await self._comments.get_many(list(dict.fromkeys(ids)))
        return [
            r.id
            for r in rows
            if r.node_id == node.id
            and r.parent_id is None
            and r.kind in (CommentKind.COMMENT, CommentKind.REVIEW)
            and r.status != CommentStatus.RESOLVED
        ]

    # ------------------------------------------------- reject and cancel
    async def reject(self, suggestion_id: uuid.UUID, user: User) -> NodeComment:
        row = await self.get_suggestion(suggestion_id)
        if row.status != CommentStatus.PENDING:
            raise Conflict(
                f"this suggestion is {row.status.value}; only a pending one can be rejected",
                code="not_pending",
            )
        payload = {**row.payload, "rejectedAt": _iso(_now()), "rejectedBy": str(user.id)}
        if not await self._comments.transition_suggestion(
            suggestion_id, CommentStatus.PENDING, status=CommentStatus.REJECTED, payload=payload
        ):
            raise Conflict("this suggestion is no longer pending", code="not_pending")
        return await self.get_suggestion(suggestion_id)

    async def cancel(self, suggestion_id: uuid.UUID, user: User) -> NodeComment:
        """`running -> cancelled`. Author only (like deleting a comment). Works
        from any replica: the state change is a compare-and-set in the database,
        the owner of the task notices within a second; a replica that owns it
        stops it at once and records the usage so far."""
        row = await self.get_suggestion(suggestion_id)
        if row.author_id is not None and row.author_id != user.id:
            raise Forbidden("only the author can cancel a revision")
        if row.status == CommentStatus.CANCELLED:
            return row
        if row.status != CommentStatus.RUNNING:
            raise Conflict(
                f"this suggestion is {row.status.value}; only a running one can be cancelled",
                code="not_running",
            )
        await self._revisions.request_cancel(suggestion_id)
        await self._revisions.commit()
        await self._runner.cancel_local(suggestion_id)
        # Whoever owns the job, the state change is this compare-and-set: it
        # wins unless the job recorded its result first (then that result
        # stands and the answer is 409 `not_running`).
        current = await self.get_suggestion(suggestion_id)
        if current.status == CommentStatus.RUNNING:
            payload = {
                **current.payload,
                "finishedAt": _iso(_now()),
                "cancelledBy": str(user.id),
            }
            await self._comments.transition_suggestion(
                suggestion_id, CommentStatus.RUNNING, status=CommentStatus.CANCELLED, payload=payload
            )
            current = await self.get_suggestion(suggestion_id)
        if current.status != CommentStatus.CANCELLED:
            raise Conflict(
                f"this suggestion is {current.status.value}; it finished before it could be cancelled",
                code="not_running",
            )
        await self._revisions.delete_job(suggestion_id)
        await self._revisions.commit()
        return current
