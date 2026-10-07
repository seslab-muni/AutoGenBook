from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import datetime, timezone

from sqlalchemy import func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from api.domain.models import CommentKind, CommentStatus, RevisionEvent, RevisionJob
from api.infrastructure.db.models import (
    NodeCommentRecord,
    RevisionEventRecord,
    RevisionJobRecord,
)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


class SqlAlchemyRevisionRepository:
    """Jobs (liveness / cancel flag) and progress events of in-process
    revisions. Methods do not commit unless they say so: the service creates
    the suggestion row, its job row and its first event in one transaction."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def commit(self) -> None:
        await self._session.commit()

    async def rollback(self) -> None:
        await self._session.rollback()

    # ------------------------------------------------------------------ jobs
    async def add_job(self, comment_id: uuid.UUID, owner: str, now: datetime) -> None:
        self._session.add(
            RevisionJobRecord(
                comment_id=comment_id, owner=owner, heartbeat_at=now, cancel_requested=False
            )
        )
        await self._session.flush()

    async def get_job(self, comment_id: uuid.UUID) -> RevisionJob | None:
        record = await self._session.get(RevisionJobRecord, comment_id)
        if record is None:
            return None
        return RevisionJob(
            comment_id=record.comment_id,
            owner=record.owner,
            heartbeat_at=_aware(record.heartbeat_at),
            cancel_requested=record.cancel_requested,
        )

    async def heartbeat(self, comment_id: uuid.UUID, now: datetime) -> None:
        await self._session.execute(
            update(RevisionJobRecord)
            .where(RevisionJobRecord.comment_id == comment_id)
            .values(heartbeat_at=now)
        )

    async def request_cancel(self, comment_id: uuid.UUID) -> None:
        await self._session.execute(
            update(RevisionJobRecord)
            .where(RevisionJobRecord.comment_id == comment_id)
            .values(cancel_requested=True)
        )

    async def poll(self, comment_id: uuid.UUID) -> tuple[CommentStatus | None, bool, bool]:
        """`(status, deleted, cancel_requested)` of a job's suggestion row;
        status None when the row is gone."""
        row = (
            await self._session.execute(
                select(
                    NodeCommentRecord.status,
                    NodeCommentRecord.deleted_at,
                    RevisionJobRecord.cancel_requested,
                )
                .select_from(NodeCommentRecord)
                .outerjoin(
                    RevisionJobRecord, RevisionJobRecord.comment_id == NodeCommentRecord.id
                )
                .where(NodeCommentRecord.id == comment_id)
                .execution_options(populate_existing=True)
            )
        ).first()
        if row is None:
            return None, True, False
        status, deleted_at, cancel = row
        return CommentStatus(status), deleted_at is not None, bool(cancel)

    async def stale_running(
        self,
        cutoff: datetime,
        *,
        owner_prefix: str | None = None,
        exclude_owner: str | None = None,
    ) -> list[uuid.UUID]:
        """Live `running` suggestions whose owner stopped heartbeating (or that
        never got a job row). With `owner_prefix`, also those owned by a process
        whose instance id starts with it (the earlier processes of this host,
        found on startup) except `exclude_owner` (this process)."""
        dead = RevisionJobRecord.heartbeat_at < cutoff
        if owner_prefix is not None:
            same_host = RevisionJobRecord.owner.startswith(owner_prefix, autoescape=True)
            if exclude_owner is not None:
                same_host = same_host & (RevisionJobRecord.owner != exclude_owner)
            dead = dead | same_host
        rows = (
            await self._session.execute(
                select(NodeCommentRecord.id)
                .outerjoin(
                    RevisionJobRecord, RevisionJobRecord.comment_id == NodeCommentRecord.id
                )
                .where(
                    NodeCommentRecord.kind == CommentKind.SUGGESTION.value,
                    NodeCommentRecord.status == CommentStatus.RUNNING.value,
                    NodeCommentRecord.deleted_at.is_(None),
                    (RevisionJobRecord.comment_id.is_(None)) | dead,
                )
            )
        ).scalars()
        return list(rows)

    # ---------------------------------------------------------------- events
    async def max_seq(self, comment_id: uuid.UUID) -> int:
        value = await self._session.scalar(
            select(func.max(RevisionEventRecord.seq)).where(
                RevisionEventRecord.comment_id == comment_id
            )
        )
        return int(value or 0)

    async def append_events(
        self, comment_id: uuid.UUID, events: Sequence[RevisionEvent]
    ) -> None:
        if not events:
            return
        await self._session.execute(
            insert(RevisionEventRecord),
            [
                {
                    "comment_id": comment_id,
                    "seq": event.seq,
                    "ts": event.ts,
                    "level": event.level,
                    "stage": event.stage,
                    "message": event.message,
                    "payload": event.payload,
                }
                for event in events
            ],
        )

    async def list_events(
        self, comment_id: uuid.UUID, after_seq: int, *, limit: int
    ) -> list[RevisionEvent]:
        rows = (
            (
                await self._session.execute(
                    select(RevisionEventRecord)
                    .where(
                        RevisionEventRecord.comment_id == comment_id,
                        RevisionEventRecord.seq > after_seq,
                    )
                    .order_by(RevisionEventRecord.seq)
                    .limit(limit)
                )
            )
            .scalars()
            .all()
        )
        return [
            RevisionEvent(
                seq=r.seq,
                ts=_aware(r.ts),
                level=r.level,
                stage=r.stage,
                message=r.message,
                payload=dict(r.payload) if r.payload is not None else None,
            )
            for r in rows
        ]
