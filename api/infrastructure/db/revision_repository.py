from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from api.domain.models import CommentKind, CommentStatus, RevisionEvent, RevisionJob
from api.infrastructure.db.models import (
    NodeCommentRecord,
    OutlineNodeRecord,
    ProjectRecord,
    RevisionEventRecord,
    RevisionJobRecord,
    UserRecord,
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

    # ----------------------------------------------------------------- clock
    # Liveness is judged against the database clock, never against the API
    # processes' clocks (replicas may disagree). SQLite (tests, no replicas)
    # has no interval arithmetic, so it falls back to the process clock.
    def _postgres(self) -> bool:
        bind = self._session.get_bind()
        return bind.dialect.name == "postgresql"

    def _db_now(self):
        return func.now() if self._postgres() else datetime.now(timezone.utc)

    def _db_cutoff(self, seconds: float):
        delta = timedelta(seconds=seconds)
        return func.now() - delta if self._postgres() else datetime.now(timezone.utc) - delta

    async def lock_user(self, user_id: uuid.UUID) -> None:
        """Serialise per-user admission (`FOR UPDATE` on the user row; held to
        the end of the transaction; a no-op on SQLite)."""
        await self._session.execute(
            # FOR NO KEY UPDATE: a reply by this user takes FOR KEY SHARE on the
            # user row (author FK) after locking its root; a plain FOR UPDATE
            # would deadlock with a start inside that thread.
            select(UserRecord.id).where(UserRecord.id == user_id).with_for_update(key_share=True)
        )

    # ------------------------------------------------------------------ jobs
    async def add_job(
        self, comment_id: uuid.UUID, owner: str, heartbeat_at: datetime | None = None
    ) -> None:
        await self._session.execute(
            insert(RevisionJobRecord).values(
                comment_id=comment_id,
                owner=owner,
                heartbeat_at=heartbeat_at if heartbeat_at is not None else self._db_now(),
                cancel_requested=False,
            )
        )

    async def delete_job(self, comment_id: uuid.UUID) -> None:
        await self._session.execute(
            delete(RevisionJobRecord).where(RevisionJobRecord.comment_id == comment_id)
        )

    async def purge_finished(self, older_than_s: float) -> int:
        """Housekeeping: drop the progress events and job rows of suggestions
        that are no longer `running` and were last touched `older_than_s` ago
        (or whose card is gone)."""
        finished = select(NodeCommentRecord.id).where(
            NodeCommentRecord.status != CommentStatus.RUNNING.value,
            NodeCommentRecord.updated_at < self._db_cutoff(older_than_s),
        )
        events = await self._session.execute(
            delete(RevisionEventRecord).where(RevisionEventRecord.comment_id.in_(finished))
        )
        await self._session.execute(
            delete(RevisionJobRecord).where(
                RevisionJobRecord.comment_id.in_(
                    select(NodeCommentRecord.id).where(
                        NodeCommentRecord.status != CommentStatus.RUNNING.value
                    )
                )
            )
        )
        return int(events.rowcount or 0)

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

    async def heartbeat(self, comment_id: uuid.UUID) -> None:
        await self._session.execute(
            update(RevisionJobRecord)
            .where(RevisionJobRecord.comment_id == comment_id)
            .values(heartbeat_at=self._db_now())
        )

    async def request_cancel(self, comment_id: uuid.UUID) -> None:
        await self._session.execute(
            update(RevisionJobRecord)
            .where(RevisionJobRecord.comment_id == comment_id)
            .values(cancel_requested=True)
        )

    async def poll(self, comment_id: uuid.UUID) -> tuple[CommentStatus | None, bool, bool]:
        """`(status, deleted, cancel_requested)` of a job's suggestion row;
        `deleted` is true when the card, its node or its project was
        soft-deleted (the job is pointless then); status None when the row is
        gone."""
        row = (
            await self._session.execute(
                select(
                    NodeCommentRecord.status,
                    NodeCommentRecord.deleted_at,
                    OutlineNodeRecord.deleted_at,
                    ProjectRecord.deleted_at,
                    RevisionJobRecord.cancel_requested,
                )
                .select_from(NodeCommentRecord)
                .outerjoin(OutlineNodeRecord, OutlineNodeRecord.id == NodeCommentRecord.node_id)
                .outerjoin(ProjectRecord, ProjectRecord.id == NodeCommentRecord.project_id)
                .outerjoin(
                    RevisionJobRecord, RevisionJobRecord.comment_id == NodeCommentRecord.id
                )
                .where(NodeCommentRecord.id == comment_id)
                .execution_options(populate_existing=True)
            )
        ).first()
        if row is None:
            return None, True, False
        status, deleted_at, node_deleted, project_deleted, cancel = row
        deleted = deleted_at is not None or node_deleted is not None or project_deleted is not None
        return CommentStatus(status), deleted, bool(cancel)

    async def stale_running(
        self,
        max_age_s: float,
        *,
        owner_prefix: str | None = None,
        exclude_owner: str | None = None,
    ) -> list[uuid.UUID]:
        """Live `running` suggestions whose owner stopped heartbeating (or that
        never got a job row). With `owner_prefix`, also those owned by a process
        whose instance id starts with it (the earlier processes of this host,
        found on startup) except `exclude_owner` (this process)."""
        dead = RevisionJobRecord.heartbeat_at < self._db_cutoff(max_age_s)
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
