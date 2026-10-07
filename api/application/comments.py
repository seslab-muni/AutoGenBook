from __future__ import annotations

import uuid
from datetime import datetime, timezone

from api.application.comment_anchors import is_resolved, resolve_anchor
from api.core.errors import Conflict, Forbidden, NotFound
from api.domain.models import CommentKind, CommentStatus, NodeComment, OutlineNode, User
from api.domain.ports import CommentRepository, OutlineRepository, ProjectRepository

# Extension points for later tracks of issue #182:
#  * `kind=review` rows: `graph_import.py` calls `CommentRepository.add` with
#    `author_id=None`, `kind=REVIEW`, status OPEN, an anchor from the engine and
#    the review fields in `payload`.
#  * `kind=suggestion` rows: a revision service adds them with status PENDING and
#    moves them through ACCEPTED / REJECTED / FAILED (`CommentRepository.update`,
#    fields `status` and `payload`).
#  * Re-anchoring: on every `contentMarkdown` PATCH, run `resolve_anchor` over
#    `list_for_node(node_id)` rows with an anchor and persist `anchor`/`status`
#    (see `reanchored_status`).

_RESOLVABLE_KINDS = (CommentKind.COMMENT, CommentKind.REVIEW)


def reanchored_status(comment: NodeComment, anchor: dict | None) -> CommentStatus:
    """Status of a comment/review row after its `anchor` was (re-)resolved:
    resolved rows stay resolved, otherwise open <-> orphaned follows the anchor."""
    if comment.status == CommentStatus.RESOLVED:
        return CommentStatus.RESOLVED
    if anchor is not None and not is_resolved(anchor):
        return CommentStatus.ORPHANED
    return CommentStatus.OPEN


class CommentService:
    def __init__(
        self,
        comment_repository: CommentRepository,
        outline_repository: OutlineRepository,
        project_repository: ProjectRepository,
    ) -> None:
        self._comments = comment_repository
        self._outline = outline_repository
        self._projects = project_repository

    async def _get_project(self, project_id: uuid.UUID) -> None:
        if await self._projects.get(project_id) is None:
            raise NotFound(f"project {project_id} does not exist")

    async def _get_node(self, project_id: uuid.UUID, node_id: uuid.UUID) -> OutlineNode:
        await self._get_project(project_id)
        node = await self._outline.get(node_id)
        if node is None or node.project_id != project_id:
            raise NotFound(f"outline node {node_id} does not exist")
        return node

    async def _get_comment(self, comment_id: uuid.UUID) -> NodeComment:
        comment = await self._comments.get(comment_id)
        if comment is None:
            raise NotFound(f"comment {comment_id} does not exist")
        return comment

    async def list_for_node(
        self,
        project_id: uuid.UUID,
        node_id: uuid.UUID,
        *,
        kind: CommentKind | None = None,
        status: CommentStatus | None = None,
    ) -> list[NodeComment]:
        await self._get_node(project_id, node_id)
        return await self._comments.list_for_node(node_id, kind=kind, status=status)

    async def list_for_project(
        self,
        project_id: uuid.UUID,
        *,
        kind: CommentKind | None = None,
        status: CommentStatus | None = None,
    ) -> list[NodeComment]:
        await self._get_project(project_id)
        return await self._comments.list_for_project(project_id, kind=kind, status=status)

    async def create(
        self,
        project_id: uuid.UUID,
        node_id: uuid.UUID,
        user: User,
        *,
        body_markdown: str,
        anchor: dict | None = None,
        parent_id: uuid.UUID | None = None,
    ) -> NodeComment:
        """A human comment (root, optionally anchored) or reply. A reply joins
        its parent's thread and takes the root's anchor/status; any `anchor` sent
        with it is ignored."""
        node = await self._get_node(project_id, node_id)
        comment_id = uuid.uuid4()
        now = datetime.now(timezone.utc)
        if parent_id is not None:
            parent = await self._comments.get(parent_id)
            if parent is None or parent.node_id != node_id:
                raise NotFound(f"comment {parent_id} does not exist on this node")
            root = parent if parent.parent_id is None else await self._comments.get(parent.thread_id)
            if root is None:
                raise NotFound(f"comment {parent_id} does not exist on this node")
            thread_id, resolved_anchor, status = root.id, root.anchor, CommentStatus.OPEN
        else:
            thread_id, status = comment_id, CommentStatus.OPEN
            resolved_anchor = None
            if anchor is not None:
                resolved_anchor = resolve_anchor(node.content_markdown, anchor)
                if not is_resolved(resolved_anchor):
                    status = CommentStatus.ORPHANED
        return await self._comments.add(
            NodeComment(
                id=comment_id,
                project_id=project_id,
                node_id=node_id,
                kind=CommentKind.COMMENT,
                author_id=user.id,
                anchor=resolved_anchor,
                status=status,
                thread_id=thread_id,
                parent_id=parent_id,
                body_markdown=body_markdown,
                payload={},
                created_at=now,
                updated_at=now,
            )
        )

    async def edit(self, comment_id: uuid.UUID, user: User, *, body_markdown: str) -> NodeComment:
        comment = await self._get_comment(comment_id)
        if comment.kind != CommentKind.COMMENT or comment.author_id != user.id:
            raise Forbidden("only the author can edit a comment")
        comment.body_markdown = body_markdown
        comment.updated_at = datetime.now(timezone.utc)
        return await self._comments.update(comment, fields=("body_markdown",))

    async def delete(self, comment_id: uuid.UUID, user: User) -> None:
        """Soft-delete. Author only; rows without an author (copilot/reviewer
        cards) can be dismissed by any signed-in user. Deleting a root removes
        its whole thread."""
        comment = await self._get_comment(comment_id)
        if comment.author_id is not None and comment.author_id != user.id:
            raise Forbidden("only the author can delete a comment")
        if comment.parent_id is None:
            await self._comments.soft_delete_thread(comment.thread_id)
        else:
            await self._comments.soft_delete(comment.id)

    async def set_resolved(self, comment_id: uuid.UUID, *, resolved: bool) -> NodeComment:
        comment = await self._get_comment(comment_id)
        if comment.parent_id is not None:
            raise Conflict("only a thread's first comment can be resolved or reopened")
        if comment.kind not in _RESOLVABLE_KINDS:
            raise Conflict(f"a {comment.kind.value} cannot be resolved")
        if resolved:
            comment.status = CommentStatus.RESOLVED
        else:
            comment.status = CommentStatus.OPEN
            comment.status = reanchored_status(comment, comment.anchor)
        comment.updated_at = datetime.now(timezone.utc)
        return await self._comments.update(comment, fields=("status",))
