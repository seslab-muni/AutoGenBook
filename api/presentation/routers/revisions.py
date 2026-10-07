from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sse_starlette.sse import EventSourceResponse

from api.application.outline import OutlineService
from api.application.revisions import RevisionParamsData, RevisionService
from api.core.db import get_sessionmaker
from api.domain.models import CommentStatus, NodeComment, User
from api.infrastructure.db.comment_repository import SqlAlchemyCommentRepository
from api.infrastructure.db.revision_repository import SqlAlchemyRevisionRepository
from api.presentation.deps import current_user, get_outline_service, get_revision_service
from api.presentation.routers.comments import to_schema as comment_to_schema
from api.presentation.routers.outline import to_schema as node_to_schema
from api.presentation.schemas.revisions import (
    RevisionCreate,
    RevisionStarted,
    RunStarted,
    SuggestionAccept,
    SuggestionAccepted,
    SuggestionProgress,
    SuggestionStarted,
    SuggestionTerminal,
)
from api.presentation.schemas.comments import Comment
from api.presentation.schemas.runs import run_to_schema

router = APIRouter(tags=["revisions"])

_SSE_POLL_INTERVAL_S = 0.5
_SSE_EVENT_BATCH_LIMIT = 200
_DONE_STATUSES = (CommentStatus.PENDING, CommentStatus.ACCEPTED, CommentStatus.REJECTED)


@router.post(
    "/projects/{project_id}/outline/{node_id}/revisions",
    response_model=RevisionStarted,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_revision(
    project_id: uuid.UUID,
    node_id: uuid.UUID,
    body: RevisionCreate,
    user: User = Depends(current_user),
    service: RevisionService = Depends(get_revision_service),
) -> SuggestionStarted | RunStarted:
    """Start a copilot revision of a section (or a selected range of it).

    `verb: "revise"` -> 202 `{kind: "suggestion", suggestion}` with the new
    `running` suggestion card; follow it with `GET /suggestions/{id}/events/stream`
    (or the node's comment list). `verb: "rewrite"` -> 202 `{kind: "run", runId,
    run}`: it is a regenerate run, with the regenerate endpoint's 409s."""
    started = await service.start(
        project_id,
        node_id,
        user,
        verb=body.verb,
        scope=body.scope,
        anchor=body.anchor.model_dump() if body.anchor is not None else None,
        instruction=body.instruction,
        params=RevisionParamsData(
            more_proofs=body.params.more_proofs,
            more_examples=body.params.more_examples,
            more_rigorous=body.params.more_rigorous,
            shorter=body.params.shorter,
            longer=body.params.longer,
            cite_sources=body.params.cite_sources,
            fix_issue_ids=tuple(body.params.fix_issue_ids),
            address_comment_ids=tuple(body.params.address_comment_ids),
        ),
        thread_id=body.thread_id,
    )
    if started.kind == "run":
        assert started.run is not None
        return RunStarted(
            run_id=started.run.id,
            run=await run_to_schema(started.run, queue_position=await service.queue_position(started.run)),
        )
    assert started.suggestion is not None
    return SuggestionStarted(suggestion=comment_to_schema(started.suggestion))


@router.post("/suggestions/{suggestion_id}/accept", response_model=SuggestionAccepted)
async def accept_suggestion(
    suggestion_id: uuid.UUID,
    body: SuggestionAccept | None = None,
    user: User = Depends(current_user),
    service: RevisionService = Depends(get_revision_service),
    outline: OutlineService = Depends(get_outline_service),
) -> SuggestionAccepted:
    """Apply a `pending` suggestion to the section (409 `stale` when the text
    changed so that it no longer applies cleanly, 409 `not_pending`,
    `node_generating`, `run_active`). Settles the thread / issues it addressed
    and re-anchors the section's other cards, all in one transaction."""
    accepted = await service.accept(
        suggestion_id, user, hunk_indexes=body.hunk_indexes if body is not None else None
    )
    node = await outline.get(accepted.project_id, accepted.node_id)
    return SuggestionAccepted(suggestion=comment_to_schema(accepted), node=node_to_schema(node))


@router.post("/suggestions/{suggestion_id}/reject", response_model=Comment)
async def reject_suggestion(
    suggestion_id: uuid.UUID,
    user: User = Depends(current_user),
    service: RevisionService = Depends(get_revision_service),
) -> Comment:
    return comment_to_schema(await service.reject(suggestion_id, user))


@router.post("/suggestions/{suggestion_id}/cancel", response_model=Comment)
async def cancel_suggestion(
    suggestion_id: uuid.UUID,
    user: User = Depends(current_user),
    service: RevisionService = Depends(get_revision_service),
) -> Comment:
    """Cancel a `running` revision (author only). Idempotent for an already
    `cancelled` one."""
    return comment_to_schema(await service.cancel(suggestion_id, user))


def _terminal_name(row: NodeComment | None) -> str:
    if row is None or row.status == CommentStatus.CANCELLED:
        return "cancelled"
    if row.status == CommentStatus.FAILED:
        return "failed"
    return "done"


async def _stream_suggestion_events(
    suggestion_id: uuid.UUID,
    after_seq: int,
    is_disconnected: Callable[[], Awaitable[bool]],
    session_factory: async_sessionmaker[AsyncSession],
    poll_interval_s: float,
) -> AsyncIterator[dict]:
    """Tail the suggestion's progress events from the database, then end with
    one terminal event once its status left `running`. Reads only the
    database, so it works on any replica and survives reconnects
    (`Last-Event-ID`)."""
    while True:
        if await is_disconnected():
            return
        async with session_factory() as session:
            events = await SqlAlchemyRevisionRepository(session).list_events(
                suggestion_id, after_seq, limit=_SSE_EVENT_BATCH_LIMIT
            )
            row = None
            if len(events) < _SSE_EVENT_BATCH_LIMIT:
                row = await SqlAlchemyCommentRepository(session).get(suggestion_id)
                terminal = row is None or row.status != CommentStatus.RUNNING
            else:
                terminal = False
        for event in events:
            after_seq = event.seq
            data = SuggestionProgress(
                seq=event.seq,
                ts=event.ts.isoformat(),
                stage=event.stage,
                level=event.level,
                message=event.message,
                payload=event.payload,
            )
            yield {"event": "progress", "id": str(event.seq), "data": data.model_dump_json(by_alias=True)}
        if terminal:
            data = SuggestionTerminal(
                status=row.status.value if row is not None else "cancelled",
                suggestion=comment_to_schema(row) if row is not None else None,
            )
            yield {
                "event": _terminal_name(row),
                "id": str(after_seq + 1),
                "data": data.model_dump_json(by_alias=True),
            }
            return
        await asyncio.sleep(poll_interval_s)


@router.get("/suggestions/{suggestion_id}/events/stream")
async def stream_suggestion_events(
    suggestion_id: uuid.UUID,
    request: Request,
    service: RevisionService = Depends(get_revision_service),
    session_factory: async_sessionmaker[AsyncSession] = Depends(get_sessionmaker),
) -> EventSourceResponse:
    """Server-sent events of a revision: `progress` events (the engine's
    `retrieve` / `revise` / `diff` stages), then one terminal `done`
    (the suggestion is `pending`; also sent for an already accepted/rejected one),
    `failed` or `cancelled` event whose data carries the final suggestion.
    Same framing as the run-event stream: event `id` = `seq` (resume with
    `Last-Event-ID`), periodic keep-alive pings, the stream ends after the
    terminal event."""
    await service.get_suggestion(suggestion_id)  # 404 unless a live suggestion
    last_event_id = request.headers.get("last-event-id")
    after_seq = int(last_event_id) if last_event_id and last_event_id.isdigit() else 0
    return EventSourceResponse(
        _stream_suggestion_events(
            suggestion_id, after_seq, request.is_disconnected, session_factory, _SSE_POLL_INTERVAL_S
        )
    )
