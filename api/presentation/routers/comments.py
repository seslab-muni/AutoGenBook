from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, Response, status

from api.application.comments import CommentService
from api.domain.models import CommentKind, CommentStatus, NodeComment, User
from api.presentation.deps import current_user, get_comment_service
from api.presentation.schemas.comments import (
    Comment,
    CommentCreate,
    CommentResolve,
    CommentUpdate,
)
from api.presentation.schemas.common import Page

router = APIRouter(tags=["comments"])


def to_schema(comment: NodeComment) -> Comment:
    return Comment(
        id=comment.id,
        project_id=comment.project_id,
        node_id=comment.node_id,
        kind=comment.kind,
        author_id=comment.author_id,
        author_name=comment.author_name,
        anchor=comment.anchor,
        status=comment.status,
        thread_id=comment.thread_id,
        parent_id=comment.parent_id,
        body_markdown=comment.body_markdown,
        payload=comment.payload,
        created_at=comment.created_at,
        updated_at=comment.updated_at,
        edited_at=comment.edited_at,
    )


# Same window as the outline list: a project's threads are read as one unit.
_DEFAULT_LIST_LIMIT = 1000


@router.get("/projects/{project_id}/comments", response_model=Page[Comment])
async def list_project_comments(
    project_id: uuid.UUID,
    kind: CommentKind | None = None,
    status: CommentStatus | None = None,
    limit: int = Query(default=_DEFAULT_LIST_LIMIT, ge=1, le=5000),
    offset: int = Query(default=0, ge=0),
    service: CommentService = Depends(get_comment_service),
) -> Page[Comment]:
    """Whole threads; `kind`/`status` select thread roots and `limit`/`offset`/
    `total` count roots (each root's replies come along)."""
    rows, total = await service.list_for_project(
        project_id, kind=kind, status=status, limit=limit, offset=offset
    )
    return Page[Comment](
        items=[to_schema(c) for c in rows], total=total, limit=limit, offset=offset
    )


@router.get("/comments/{comment_id}", response_model=Comment)
async def get_comment(
    comment_id: uuid.UUID, service: CommentService = Depends(get_comment_service)
) -> Comment:
    """One card, full payload (a suggestion's `originalMarkdown` /
    `replacementMarkdown` included - the project-wide list leaves them out)."""
    return to_schema(await service.get(comment_id))


@router.get("/projects/{project_id}/outline/{node_id}/comments", response_model=Page[Comment])
async def list_node_comments(
    project_id: uuid.UUID,
    node_id: uuid.UUID,
    kind: CommentKind | None = None,
    status: CommentStatus | None = None,
    service: CommentService = Depends(get_comment_service),
) -> Page[Comment]:
    """Whole threads of the node, not paged (`total` counts thread roots)."""
    rows = await service.list_for_node(project_id, node_id, kind=kind, status=status)
    items = [to_schema(c) for c in rows]
    return Page[Comment](
        items=items,
        total=sum(1 for c in rows if c.parent_id is None),
        limit=max(len(items), 1),
        offset=0,
    )


@router.post(
    "/projects/{project_id}/outline/{node_id}/comments",
    response_model=Comment,
    status_code=status.HTTP_201_CREATED,
)
async def create_node_comment(
    project_id: uuid.UUID,
    node_id: uuid.UUID,
    body: CommentCreate,
    user: User = Depends(current_user),
    service: CommentService = Depends(get_comment_service),
) -> Comment:
    comment = await service.create(
        project_id,
        node_id,
        user,
        body_markdown=body.body_markdown,
        anchor=body.anchor.model_dump() if body.anchor is not None else None,
        parent_id=body.parent_id,
    )
    return to_schema(comment)


@router.patch("/comments/{comment_id}", response_model=Comment)
async def update_comment(
    comment_id: uuid.UUID,
    body: CommentUpdate,
    user: User = Depends(current_user),
    service: CommentService = Depends(get_comment_service),
) -> Comment:
    return to_schema(await service.edit(comment_id, user, body_markdown=body.body_markdown))


@router.delete("/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_comment(
    comment_id: uuid.UUID,
    user: User = Depends(current_user),
    service: CommentService = Depends(get_comment_service),
) -> Response:
    await service.delete(comment_id, user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/comments/{comment_id}/resolve", response_model=Comment)
async def resolve_comment(
    comment_id: uuid.UUID,
    body: CommentResolve | None = None,
    service: CommentService = Depends(get_comment_service),
) -> Comment:
    """Resolve a thread (`{}` or `{"resolved": true}`) or reopen it
    (`{"resolved": false}`). Only a thread's root can be resolved."""
    resolved = body.resolved if body is not None else True
    return to_schema(await service.set_resolved(comment_id, resolved=resolved))
