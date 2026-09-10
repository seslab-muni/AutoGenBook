from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sse_starlette.sse import EventSourceResponse
from starlette import status

from api.application.runs import RunService, build_done_event
from api.core.db import get_sessionmaker
from api.domain.models import ArtifactKind, RunStatus, User
from api.infrastructure.db.run_repository import SqlAlchemyRunEventRepository, SqlAlchemyRunRepository
from api.presentation.deps import current_user, get_run_service
from api.presentation.schemas.common import Page, PageParams
from api.presentation.schemas.runs import (
    ExportRequestIn,
    RegenerateRequestIn,
    Run,
    RunArtifact,
    RunArtifactSummary,
    RunEvent,
    RunEventPage,
    RunOptionsIn,
    artifact_counts_to_schema,
    artifact_to_schema,
    event_to_schema,
    run_to_schema,
)

router = APIRouter(tags=["runs"])

# Terminal SSE stages a client can rely on to stop listening once a "done"
# event arrives, per `GenerationService._emit_done`.
_DONE_STAGE = "done"
_SSE_POLL_INTERVAL_S = 1.0
_SSE_EVENT_BATCH_LIMIT = 200
_TERMINAL_RUN_STATUSES = {RunStatus.succeeded, RunStatus.failed, RunStatus.cancelled}


@router.post(
    "/projects/{project_id}/runs", response_model=Run, status_code=status.HTTP_202_ACCEPTED
)
async def create_run(
    project_id: uuid.UUID,
    body: RunOptionsIn,
    user: User = Depends(current_user),
    service: RunService = Depends(get_run_service),
) -> Run:
    run = await service.create(
        project_id,
        outline=body.outline,
        output_format=body.output_format,
        allow_subdivision=body.allow_subdivision,
        enable_web_rag=body.enable_web_rag,
        audit_book=body.audit_book,
        audit_book_mode=body.audit_book_mode,
        legacy_tex=body.legacy_tex,
        fail_fast_schema=body.fail_fast_schema,
        llm_model=body.llm_model,
        started_by=user.id,
    )
    return await run_to_schema(run, queue_position=await service.queue_position(run))


@router.get("/projects/{project_id}/runs", response_model=Page[Run])
async def list_runs(
    project_id: uuid.UUID,
    # Named `run_status` (not `status`) to avoid shadowing the module-level
    # `starlette.status` import within this function's scope.
    run_status: list[RunStatus] | None = Query(default=None, alias="status"),
    params: PageParams = Depends(),
    service: RunService = Depends(get_run_service),
) -> Page[Run]:
    runs, total = await service.list(
        project_id, limit=params.limit, offset=params.offset, statuses=run_status
    )
    return Page[Run](
        items=[
            await run_to_schema(run, queue_position=await service.queue_position(run))
            for run in runs
        ],
        total=total,
        limit=params.limit,
        offset=params.offset,
    )


@router.post(
    "/projects/{project_id}/outline/{node_id}/regenerate",
    response_model=Run,
    status_code=status.HTTP_202_ACCEPTED,
)
async def regenerate_node(
    project_id: uuid.UUID,
    node_id: uuid.UUID,
    body: RegenerateRequestIn,
    user: User = Depends(current_user),
    service: RunService = Depends(get_run_service),
) -> Run:
    run = await service.regenerate_node(
        project_id, node_id, prompt_modifier=body.prompt_modifier, started_by=user.id
    )
    return await run_to_schema(run, queue_position=await service.queue_position(run))


@router.get("/runs/{run_id}", response_model=Run)
async def get_run(
    run_id: uuid.UUID, service: RunService = Depends(get_run_service)
) -> Run:
    run = await service.get(run_id)
    return await run_to_schema(run, queue_position=await service.queue_position(run))


@router.post(
    "/runs/{run_id}/cancel", response_model=Run, status_code=status.HTTP_202_ACCEPTED
)
async def cancel_run(
    run_id: uuid.UUID, service: RunService = Depends(get_run_service)
) -> Run:
    run = await service.cancel(run_id)
    return await run_to_schema(run, queue_position=await service.queue_position(run))


@router.post(
    "/runs/{run_id}/exports", response_model=Run, status_code=status.HTTP_202_ACCEPTED
)
async def export_run(
    run_id: uuid.UUID,
    body: ExportRequestIn,
    user: User = Depends(current_user),
    service: RunService = Depends(get_run_service),
) -> Run:
    run = await service.export(run_id, output_format=body.format, started_by=user.id)
    return await run_to_schema(run, queue_position=await service.queue_position(run))


@router.post(
    "/runs/{run_id}/retry", response_model=Run, status_code=status.HTTP_202_ACCEPTED
)
async def retry_run(
    run_id: uuid.UUID,
    user: User = Depends(current_user),
    service: RunService = Depends(get_run_service),
) -> Run:
    run = await service.retry(run_id, started_by=user.id)
    return await run_to_schema(run, queue_position=await service.queue_position(run))


@router.get("/runs/{run_id}/events", response_model=RunEventPage)
async def list_run_events(
    run_id: uuid.UUID,
    after_seq: int = Query(default=0, ge=0, alias="afterSeq"),
    limit: int = Query(default=200, ge=1, le=1000),
    service: RunService = Depends(get_run_service),
) -> RunEventPage:
    events, total = await service.events(run_id, after_seq=after_seq, limit=limit)
    return RunEventPage(
        items=[event_to_schema(event) for event in events],
        total=total,
        limit=limit,
        after_seq=after_seq,
    )


@router.get("/runs/{run_id}/artifacts", response_model=Page[RunArtifact])
async def list_run_artifacts(
    run_id: uuid.UUID,
    kind: ArtifactKind | None = Query(default=None),
    params: PageParams = Depends(),
    service: RunService = Depends(get_run_service),
) -> Page[RunArtifact]:
    pairs, total = await service.artifacts(
        run_id, limit=params.limit, offset=params.offset, kind=kind
    )
    return Page[RunArtifact](
        items=[artifact_to_schema(artifact, file) for artifact, file in pairs],
        total=total,
        limit=params.limit,
        offset=params.offset,
    )


@router.get("/runs/{run_id}/artifacts/summary", response_model=RunArtifactSummary)
async def get_run_artifacts_summary(
    run_id: uuid.UUID,
    service: RunService = Depends(get_run_service),
) -> RunArtifactSummary:
    counts = await service.artifact_counts_by_kind(run_id)
    return artifact_counts_to_schema(counts)


def _sse_event_name(event: RunEvent) -> str:
    if event.stage in ("section", _DONE_STAGE):
        return event.stage
    if event.stage == "log" and event.level == "info":
        return "log"
    return "stage"


async def _stream_events(
    run_id: uuid.UUID,
    after_seq: int,
    is_disconnected: Callable[[], Awaitable[bool]],
    session_factory: async_sessionmaker[AsyncSession],
    poll_interval_s: float,
) -> AsyncIterator[dict]:
    """Split out of `stream_run_events` so it can be driven directly in
    tests (a fake `is_disconnected`, no real network stream) instead of only
    through a live SSE connection - see issue #63's regression test for the
    "a run ends without ever emitting done" fallback below, which would
    otherwise need to prove a stream polls forever to fail meaningfully."""
    while True:
        if await is_disconnected():
            return
        # A fresh, short-lived session per poll iteration: the `service`
        # from `Depends(get_run_service)` is bound to a session that
        # FastAPI closes as soon as this route function returns (i.e.
        # before this generator starts streaming), so reusing it here
        # would silently re-acquire and pin a pooled connection for the
        # entire lifetime of the stream.
        async with session_factory() as session:
            events = await SqlAlchemyRunEventRepository(session).list_after(
                run_id, after_seq, limit=_SSE_EVENT_BATCH_LIMIT
            )
            run = None
            if len(events) < _SSE_EVENT_BATCH_LIMIT:
                # Only worth the extra query once the event tail looks
                # drained - cheap insurance against a run that ends
                # without ever emitting "done" (issue #63), so this
                # connection, its pooled DB connection, and this 1Hz
                # query loop don't get held open forever.
                run = await SqlAlchemyRunRepository(session).get(run_id)
        done = False
        for event in events:
            after_seq = event.seq
            schema = event_to_schema(event)
            if schema.stage == _DONE_STAGE:
                done = True
            yield {
                "event": _sse_event_name(schema),
                "id": str(schema.seq),
                "data": schema.model_dump_json(by_alias=True),
            }
        if done:
            return
        if run is not None and run.status in _TERMINAL_RUN_STATUSES:
            synthetic = event_to_schema(build_done_event(run, after_seq + 1))
            yield {
                "event": _sse_event_name(synthetic),
                "id": str(synthetic.seq),
                "data": synthetic.model_dump_json(by_alias=True),
            }
            return
        await asyncio.sleep(poll_interval_s)


@router.get("/runs/{run_id}/events/stream")
async def stream_run_events(
    run_id: uuid.UUID,
    request: Request,
    service: RunService = Depends(get_run_service),
    session_factory: async_sessionmaker[AsyncSession] = Depends(get_sessionmaker),
) -> EventSourceResponse:
    await service.get(run_id)  # 404 if the run doesn't exist

    last_event_id = request.headers.get("last-event-id")
    after_seq = int(last_event_id) if last_event_id and last_event_id.isdigit() else 0

    return EventSourceResponse(
        _stream_events(
            run_id, after_seq, request.is_disconnected, session_factory, _SSE_POLL_INTERVAL_S
        )
    )
