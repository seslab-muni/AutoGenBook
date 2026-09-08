from __future__ import annotations

import uuid
from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import ConfigDict
from starlette.concurrency import run_in_threadpool

from api.domain.models import ArtifactKind
from api.domain.models import File as FileDomain
from api.domain.models import Run as RunDomain
from api.domain.models import RunArtifact as RunArtifactDomain
from api.domain.models import RunEvent as RunEventDomain
from api.domain.models import RunKind, RunStatus
from api.presentation.schemas.common import BaseSchema


class RunOptionsIn(BaseSchema):
    """Request body of `POST /projects/{id}/runs`. `output_format` defaults
    to the project's own `output_format` when omitted (resolved by
    `RunService.create`'s caller, not here).

    `resume`, `exportTexOnly` and `rebuildKb` are deliberately not exposed
    here (issue #60): they only have meaningful semantics on a
    `regenerate_section`/`export` run resuming an existing work directory,
    which `RunService.regenerate_node`/`export` already set on the run's
    `RunOptions` themselves via `dataclasses.replace(base_run.options, ...)`.
    A fresh `full` run always starts a brand-new work directory, so
    `resume=True` would resume nothing, `exportTexOnly=True` has no base
    Markdown to skip regenerating, and `rebuildKb` has no pre-existing index
    to force a rebuild of."""

    model_config = ConfigDict(extra="forbid")

    outline: Literal["project", "generate"] = "project"
    output_format: Literal["markdown", "latex", "pdf"] | None = None
    allow_subdivision: bool = True
    enable_web_rag: bool = False
    audit_book: bool = False
    audit_book_mode: Literal["off", "warn", "strict"] = "warn"
    legacy_tex: bool = False
    fail_fast_schema: bool = False


class RegenerateRequestIn(BaseSchema):
    """Request body of `POST /projects/{id}/outline/{nodeId}/regenerate`."""

    model_config = ConfigDict(extra="forbid")

    prompt_modifier: str | None = None


class ExportRequestIn(BaseSchema):
    """Request body of `POST /runs/{id}/exports`."""

    model_config = ConfigDict(extra="forbid")

    format: Literal["latex", "pdf"]


class RunOptionsOut(BaseSchema):
    outline: Literal["project", "generate"]
    output_format: Literal["markdown", "latex", "pdf"]
    allow_subdivision: bool
    enable_web_rag: bool
    audit_book: bool
    audit_book_mode: Literal["off", "warn", "strict"]
    legacy_tex: bool
    rebuild_kb: bool
    fail_fast_schema: bool
    resume: bool
    export_tex_only: bool
    prompt_modifier: str | None = None


class Run(BaseSchema):
    id: uuid.UUID
    project_id: uuid.UUID
    kind: RunKind
    status: RunStatus
    options: RunOptionsOut
    base_run_id: uuid.UUID | None
    target_node_id: uuid.UUID | None
    exit_code: int | None
    error: str | None
    total_tokens: int | None
    total_cost_usd: float | None
    queued_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    # `False` once the work directory has been swept by
    # `api.application.runs.sweep_stale_work_dirs` (`RUNS_RETENTION_DAYS`
    # after the run finished) - a `regenerate`/`export` run (issue #11) can
    # no longer reuse this run as its base.
    resumable: bool
    started_by_id: uuid.UUID | None = None
    started_by_name: str | None = None


class RunEvent(BaseSchema):
    seq: int
    ts: datetime
    level: str
    stage: str
    message: str
    payload: dict | None = None


class RunEventPage(BaseSchema):
    """`GET /runs/{id}/events`'s response envelope. Deliberately not `Page`:
    this endpoint pages by `seq` (a monotonically increasing cursor), not by
    row position, so `Page.offset` echoing `afterSeq` misrepresented a
    sequence cursor as a row offset (issue #61)."""

    items: list[RunEvent]
    total: int
    limit: int
    after_seq: int


async def run_to_schema(run: RunDomain) -> Run:
    # Off the event loop (issue #55): `Path.is_dir()` is a `stat(2)` against
    # the shared `runs_data` volume, done once per run in a list response -
    # cheap on a healthy local disk, but still a blocking syscall issued
    # directly on the loop for every row instead of handed to the
    # threadpool the way every other filesystem touch in this codebase is.
    resumable = await run_in_threadpool(Path(run.work_dir).is_dir)
    return Run(
        id=run.id,
        project_id=run.project_id,
        kind=run.kind,
        status=run.status,
        options=RunOptionsOut.model_validate(run.options),
        base_run_id=run.base_run_id,
        target_node_id=run.target_node_id,
        exit_code=run.exit_code,
        error=run.error,
        total_tokens=run.total_tokens,
        total_cost_usd=run.total_cost_usd,
        queued_at=run.queued_at,
        started_at=run.started_at,
        finished_at=run.finished_at,
        resumable=resumable,
        started_by_id=run.started_by,
        started_by_name=run.started_by_name,
    )


def event_to_schema(event: RunEventDomain) -> RunEvent:
    return RunEvent(
        seq=event.seq,
        ts=event.ts,
        level=event.level,
        stage=event.stage,
        message=event.message,
        payload=event.payload,
    )


class RunArtifact(BaseSchema):
    kind: ArtifactKind
    relative_path: str
    file_id: uuid.UUID
    filename: str
    size_bytes: int
    content_type: str


def artifact_to_schema(artifact: RunArtifactDomain, file: FileDomain) -> RunArtifact:
    return RunArtifact(
        kind=artifact.kind,
        relative_path=artifact.relative_path,
        file_id=file.id,
        filename=file.filename,
        size_bytes=file.size_bytes,
        content_type=file.content_type,
    )
