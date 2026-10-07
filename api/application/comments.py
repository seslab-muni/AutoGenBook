from __future__ import annotations

import uuid
from dataclasses import replace
from datetime import datetime, timezone

from api.application.comment_anchors import is_resolved, resolve_anchor
from api.application.reanchor import reanchored_status
from api.core.errors import Conflict, Forbidden, NotFound
from api.domain.models import CommentKind, CommentStatus, NodeComment, OutlineNode, User
from api.domain.ports import CommentRepository, OutlineRepository, ProjectRepository

# Related modules of issue #182:
#  * `api.application.reanchor.reanchor_node_cards` - the single function that
#    re-anchors a node's live cards when its text changes (called from the
#    outline service, the graph import and suggestion accept).
#  * `api.application.review_import` - writes `kind=review` rows (author NULL)
#    from the engine's `section_reviews/<key>.json`.
#  * `api.application.revisions` - the revision service: `kind=suggestion`
#    rows (running -> pending/failed/cancelled -> accepted/rejected), possibly
#    nested in a comment thread (`parent_id`/`thread_id` = the root).

_RESOLVABLE_KINDS = (CommentKind.COMMENT, CommentKind.REVIEW)


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

    @staticmethod
    def _present(comments: list[NodeComment]) -> list[NodeComment]:
        """Replies carry no state of their own: show the root's anchor/status."""
        roots = {c.id: c for c in comments if c.parent_id is None}
        return [
            replace(c, anchor=roots[c.thread_id].anchor, status=roots[c.thread_id].status)
            if c.parent_id is not None and c.kind == CommentKind.COMMENT and c.thread_id in roots
            else c
            for c in comments
        ]

    async def _present_one(self, comment: NodeComment) -> NodeComment:
        if comment.parent_id is None or comment.kind != CommentKind.COMMENT:
            return comment
        root = await self._comments.get(comment.thread_id)
        return self._present([root, comment])[1] if root is not None else comment

    async def list_for_node(
        self,
        project_id: uuid.UUID,
        node_id: uuid.UUID,
        *,
        kind: CommentKind | None = None,
        status: CommentStatus | None = None,
    ) -> list[NodeComment]:
        """Whole threads (root + live replies); the filters select roots."""
        await self._get_node(project_id, node_id)
        return self._present(
            await self._comments.list_threads_for_node(node_id, kind=kind, status=status)
        )

    async def list_for_project(
        self,
        project_id: uuid.UUID,
        *,
        kind: CommentKind | None = None,
        status: CommentStatus | None = None,
        limit: int,
        offset: int,
    ) -> tuple[list[NodeComment], int]:
        """Like `list_for_node`; `limit`/`offset` page the matching roots and
        the total counts roots."""
        await self._get_project(project_id)
        rows, total = await self._comments.list_threads_for_project(
            project_id, kind=kind, status=status, limit=limit, offset=offset
        )
        return self._present(rows), total

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
        """A human comment (root, optionally anchored) or reply. Threads are
        flat: a reply's `parent_id` and `thread_id` are both the root's id even
        when it answers another reply, it stores no anchor/status of its own,
        and it reopens a resolved root. Replies need a `comment` or `review`
        root (409 under a suggestion)."""
        node = await self._get_node(project_id, node_id)
        comment_id = uuid.uuid4()
        now = datetime.now(timezone.utc)
        stored_anchor: dict | None = None
        status = CommentStatus.OPEN
        thread_id = comment_id
        if parent_id is not None:
            parent = await self._comments.get(parent_id)
            if parent is None or parent.node_id != node_id:
                raise NotFound(f"comment {parent_id} does not exist on this node")
            root = parent if parent.parent_id is None else await self._comments.get(parent.thread_id)
            if root is None:
                raise NotFound(f"comment {parent_id} does not exist on this node")
            if root.kind not in _RESOLVABLE_KINDS:
                raise Conflict(f"cannot reply to a {root.kind.value}")
            thread_id, parent_id = root.id, root.id
        elif anchor is not None:
            stored_anchor = resolve_anchor(node.content_markdown, anchor)
            if not is_resolved(stored_anchor):
                status = CommentStatus.ORPHANED
        created = await self._comments.add(
            NodeComment(
                id=comment_id,
                project_id=project_id,
                node_id=node_id,
                kind=CommentKind.COMMENT,
                author_id=user.id,
                anchor=stored_anchor,
                status=status,
                thread_id=thread_id,
                parent_id=parent_id,
                body_markdown=body_markdown,
                payload={},
                created_at=now,
                updated_at=now,
                author_name=user.display_name,
            )
        )
        return await self._present_one(created)

    async def edit(self, comment_id: uuid.UUID, user: User, *, body_markdown: str) -> NodeComment:
        comment = await self._get_comment(comment_id)
        if comment.kind != CommentKind.COMMENT or comment.author_id != user.id:
            raise Forbidden("only the author can edit a comment")
        comment.body_markdown = body_markdown
        comment.edited_at = comment.updated_at = datetime.now(timezone.utc)
        updated = await self._comments.update(comment, fields=("body_markdown", "edited_at"))
        return await self._present_one(updated)

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
