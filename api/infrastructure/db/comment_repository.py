from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import datetime, timezone

from sqlalchemy import case, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from api.core.errors import NotFound
from api.domain.models import (
    SUGGESTION_ACTIVE_STATUSES,
    CommentKind,
    CommentStatus,
    NodeComment,
)
from api.infrastructure.db.models import (
    NodeCommentRecord,
    OutlineNodeRecord,
    ProjectRecord,
    UserRecord,
)


def _as_aware_utc(value: datetime) -> datetime:
    # SQLite drops tzinfo on round-trip (unlike Postgres); re-attach it.
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _to_domain(record: NodeCommentRecord, author_name: str | None = None) -> NodeComment:
    return NodeComment(
        id=record.id,
        project_id=record.project_id,
        node_id=record.node_id,
        kind=CommentKind(record.kind),
        author_id=record.author_id,
        anchor=dict(record.anchor) if record.anchor is not None else None,
        status=CommentStatus(record.status),
        thread_id=record.thread_id,
        parent_id=record.parent_id,
        body_markdown=record.body_markdown,
        payload=dict(record.payload or {}),
        created_at=_as_aware_utc(record.created_at),
        updated_at=_as_aware_utc(record.updated_at),
        deleted_at=_as_aware_utc(record.deleted_at) if record.deleted_at is not None else None,
        edited_at=_as_aware_utc(record.edited_at) if record.edited_at is not None else None,
        author_name=author_name,
    )


_MUTABLE_FIELDS = ("anchor", "status", "body_markdown", "payload", "edited_at")


class SqlAlchemyCommentRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    def _select(self):
        # Rows of a soft-deleted node or project never surface: join both and
        # require them live. `author_name` is the author's current display name.
        return (
            select(NodeCommentRecord, UserRecord.display_name)
            .join(OutlineNodeRecord, OutlineNodeRecord.id == NodeCommentRecord.node_id)
            .join(ProjectRecord, ProjectRecord.id == NodeCommentRecord.project_id)
            .outerjoin(UserRecord, UserRecord.id == NodeCommentRecord.author_id)
            .where(
                NodeCommentRecord.deleted_at.is_(None),
                OutlineNodeRecord.deleted_at.is_(None),
                ProjectRecord.deleted_at.is_(None),
            )
            .order_by(NodeCommentRecord.created_at, NodeCommentRecord.id)
        )

    @staticmethod
    def _roots(statement, kind: CommentKind | None, status: CommentStatus | None):
        statement = statement.where(NodeCommentRecord.parent_id.is_(None))
        if kind is not None:
            statement = statement.where(NodeCommentRecord.kind == kind.value)
        if status is not None:
            statement = statement.where(NodeCommentRecord.status == status.value)
        return statement

    async def _with_replies(self, roots: list[NodeComment]) -> list[NodeComment]:
        if not roots:
            return []
        rows = (
            await self._session.execute(
                self._select().where(
                    NodeCommentRecord.parent_id.is_not(None),
                    NodeCommentRecord.thread_id.in_([root.id for root in roots]),
                )
            )
        ).all()
        merged = roots + [_to_domain(record, name) for record, name in rows]
        merged.sort(key=lambda c: (c.created_at, c.id))
        return merged

    async def get(self, comment_id: uuid.UUID) -> NodeComment | None:
        row = (
            await self._session.execute(
                self._select().where(NodeCommentRecord.id == comment_id)
            )
        ).first()
        return _to_domain(row[0], row[1]) if row is not None else None

    async def list_threads_for_node(
        self,
        node_id: uuid.UUID,
        *,
        kind: CommentKind | None = None,
        status: CommentStatus | None = None,
    ) -> list[NodeComment]:
        statement = self._roots(
            self._select().where(NodeCommentRecord.node_id == node_id), kind, status
        )
        rows = (await self._session.execute(statement)).all()
        return await self._with_replies([_to_domain(record, name) for record, name in rows])

    async def list_threads_for_project(
        self,
        project_id: uuid.UUID,
        *,
        kind: CommentKind | None = None,
        status: CommentStatus | None = None,
        limit: int,
        offset: int,
    ) -> tuple[list[NodeComment], int]:
        statement = self._roots(
            self._select().where(NodeCommentRecord.project_id == project_id), kind, status
        )
        total = await self._session.scalar(
            select(func.count()).select_from(statement.order_by(None).subquery())
        )
        rows = (await self._session.execute(statement.limit(limit).offset(offset))).all()
        roots = [_to_domain(record, name) for record, name in rows]
        return await self._with_replies(roots), int(total or 0)

    async def add(self, comment: NodeComment) -> NodeComment:
        """Insert. A reply first locks its thread root (`FOR UPDATE`, a no-op
        on SQLite) and re-checks it is still live in this transaction, so a
        concurrent thread delete can't leave a live reply under a deleted
        root; a resolved root is reopened (`open`, or `orphaned` when its
        anchor has null offsets). The result is built from the inserted
        record, not re-read through the live-node join."""
        if comment.parent_id is not None:
            root = (
                await self._session.execute(
                    select(NodeCommentRecord)
                    .where(NodeCommentRecord.id == comment.thread_id)
                    .with_for_update()
                )
            ).scalar_one_or_none()
            if root is None or root.deleted_at is not None:
                await self._session.rollback()
                raise NotFound(f"comment {comment.thread_id} does not exist")
            if root.status == CommentStatus.RESOLVED.value:
                anchor = root.anchor
                orphaned = anchor is not None and anchor.get("start") is None
                root.status = (CommentStatus.ORPHANED if orphaned else CommentStatus.OPEN).value
                root.updated_at = comment.updated_at
        record = NodeCommentRecord(
            id=comment.id,
            project_id=comment.project_id,
            node_id=comment.node_id,
            kind=comment.kind.value,
            author_id=comment.author_id,
            anchor=comment.anchor,
            status=comment.status.value,
            thread_id=comment.thread_id,
            parent_id=comment.parent_id,
            body_markdown=comment.body_markdown,
            payload=comment.payload,
            created_at=comment.created_at,
            updated_at=comment.updated_at,
        )
        self._session.add(record)
        await self._session.commit()
        return _to_domain(record, comment.author_name)

    async def update(self, comment: NodeComment, *, fields: Sequence[str]) -> NodeComment:
        record = await self._session.get(NodeCommentRecord, comment.id)
        if record is None or record.deleted_at is not None:
            raise NotFound(f"comment {comment.id} does not exist")
        for name in fields:
            if name not in _MUTABLE_FIELDS:
                raise ValueError(f"{name!r} is not an updatable comment field")
            value = getattr(comment, name)
            setattr(record, name, value.value if isinstance(value, CommentStatus) else value)
        record.updated_at = comment.updated_at
        await self._session.commit()
        updated = await self.get(comment.id)
        if updated is None:
            raise NotFound(f"comment {comment.id} does not exist")
        return updated

    async def soft_delete_thread(self, thread_id: uuid.UUID) -> None:
        # Lock the root first so a racing reply insert (which locks it too)
        # either lands before this sweep or sees the root deleted.
        await self._session.execute(
            select(NodeCommentRecord.id)
            .where(NodeCommentRecord.id == thread_id)
            .with_for_update()
        )
        await self._session.execute(
            update(NodeCommentRecord)
            .where(
                NodeCommentRecord.thread_id == thread_id,
                NodeCommentRecord.deleted_at.is_(None),
            )
            .values(deleted_at=datetime.now(timezone.utc))
        )
        await self._session.commit()

    async def soft_delete(self, comment_id: uuid.UUID) -> None:
        await self._session.execute(
            update(NodeCommentRecord)
            .where(NodeCommentRecord.id == comment_id, NodeCommentRecord.deleted_at.is_(None))
            .values(deleted_at=datetime.now(timezone.utc))
        )
        await self._session.commit()

    async def counts_for_project(
        self, project_id: uuid.UUID
    ) -> dict[uuid.UUID, tuple[int, int]]:
        """`{node_id: (open_comment_count, pending_suggestion_count)}` in one
        grouped query. Open = root `comment` rows that are open/orphaned; pending =
        `suggestion` rows (any depth) that are running/pending."""
        is_open_comment = (
            (NodeCommentRecord.kind == CommentKind.COMMENT.value)
            & NodeCommentRecord.parent_id.is_(None)
            & NodeCommentRecord.status.in_(
                [CommentStatus.OPEN.value, CommentStatus.ORPHANED.value]
            )
        )
        is_pending_suggestion = (NodeCommentRecord.kind == CommentKind.SUGGESTION.value) & (
            NodeCommentRecord.status.in_([s.value for s in SUGGESTION_ACTIVE_STATUSES])
        )
        statement = (
            select(
                NodeCommentRecord.node_id,
                func.sum(case((is_open_comment, 1), else_=0)),
                func.sum(case((is_pending_suggestion, 1), else_=0)),
            )
            .where(
                NodeCommentRecord.project_id == project_id,
                NodeCommentRecord.deleted_at.is_(None),
            )
            .group_by(NodeCommentRecord.node_id)
        )
        rows = (await self._session.execute(statement)).all()
        return {node_id: (int(opened or 0), int(pending or 0)) for node_id, opened, pending in rows}
