from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import datetime, timezone

from sqlalchemy import case, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from api.core.errors import NotFound
from api.domain.models import (
    SUGGESTION_DECIDED_STATUSES,
    CommentKind,
    CommentStatus,
    NodeComment,
)
from api.infrastructure.db.models import NodeCommentRecord, OutlineNodeRecord, UserRecord


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
        author_name=author_name,
    )


_MUTABLE_FIELDS = ("anchor", "status", "body_markdown", "payload")


class SqlAlchemyCommentRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    def _select(self):
        # Rows of a soft-deleted node never surface: join the node and require
        # it live. `author_name` is the author's current display name.
        return (
            select(NodeCommentRecord, UserRecord.display_name)
            .join(OutlineNodeRecord, OutlineNodeRecord.id == NodeCommentRecord.node_id)
            .outerjoin(UserRecord, UserRecord.id == NodeCommentRecord.author_id)
            .where(
                NodeCommentRecord.deleted_at.is_(None),
                OutlineNodeRecord.deleted_at.is_(None),
            )
            .order_by(NodeCommentRecord.created_at, NodeCommentRecord.id)
        )

    @staticmethod
    def _filtered(statement, kind: CommentKind | None, status: CommentStatus | None):
        if kind is not None:
            statement = statement.where(NodeCommentRecord.kind == kind.value)
        if status is not None:
            statement = statement.where(NodeCommentRecord.status == status.value)
        return statement

    async def get(self, comment_id: uuid.UUID) -> NodeComment | None:
        row = (
            await self._session.execute(
                self._select().where(NodeCommentRecord.id == comment_id)
            )
        ).first()
        return _to_domain(row[0], row[1]) if row is not None else None

    async def list_for_node(
        self,
        node_id: uuid.UUID,
        *,
        kind: CommentKind | None = None,
        status: CommentStatus | None = None,
    ) -> list[NodeComment]:
        statement = self._filtered(
            self._select().where(NodeCommentRecord.node_id == node_id), kind, status
        )
        rows = (await self._session.execute(statement)).all()
        return [_to_domain(record, name) for record, name in rows]

    async def list_for_project(
        self,
        project_id: uuid.UUID,
        *,
        kind: CommentKind | None = None,
        status: CommentStatus | None = None,
    ) -> list[NodeComment]:
        statement = self._filtered(
            self._select().where(NodeCommentRecord.project_id == project_id), kind, status
        )
        rows = (await self._session.execute(statement)).all()
        return [_to_domain(record, name) for record, name in rows]

    async def add(self, comment: NodeComment) -> NodeComment:
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
        created = await self.get(comment.id)
        assert created is not None
        return created

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
        grouped query. Open = root `comment` rows not yet resolved; pending =
        root `suggestion` rows not yet accepted/rejected/failed."""
        is_open_comment = (NodeCommentRecord.kind == CommentKind.COMMENT.value) & (
            NodeCommentRecord.status.in_(
                [CommentStatus.OPEN.value, CommentStatus.ORPHANED.value]
            )
        )
        is_pending_suggestion = (NodeCommentRecord.kind == CommentKind.SUGGESTION.value) & (
            NodeCommentRecord.status.not_in([s.value for s in SUGGESTION_DECIDED_STATUSES])
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
                NodeCommentRecord.parent_id.is_(None),
            )
            .group_by(NodeCommentRecord.node_id)
        )
        rows = (await self._session.execute(statement)).all()
        return {node_id: (int(opened or 0), int(pending or 0)) for node_id, opened, pending in rows}
