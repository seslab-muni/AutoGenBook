from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import datetime, timezone

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from api.domain.models import OutlineNode
from api.infrastructure.db.models import OutlineNodeRecord


def _as_aware_utc(value):
    # SQLite drops tzinfo on round-trip (unlike Postgres); re-attach it.
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _to_domain(record: OutlineNodeRecord) -> OutlineNode:
    return OutlineNode(
        id=record.id,
        project_id=record.project_id,
        parent_id=record.parent_id,
        order_index=record.order_index,
        title=record.title,
        summary=record.summary,
        status=record.status,
        target_pages=float(record.target_pages),
        word_budget=record.word_budget,
        actual_words=record.actual_words,
        equation_density_level=record.equation_density_level,
        math_level=record.math_level,
        sub_prompt=record.sub_prompt,
        content_markdown=record.content_markdown,
        content_latex=record.content_latex,
        rag_citations=list(record.rag_citations),
        reviewer_score=(
            float(record.reviewer_score) if record.reviewer_score is not None else None
        ),
        reviewer_notes=record.reviewer_notes,
        structure_locked=record.structure_locked,
        created_at=_as_aware_utc(record.created_at),
        updated_at=_as_aware_utc(record.updated_at),
        deleted_at=(
            _as_aware_utc(record.deleted_at) if record.deleted_at is not None else None
        ),
        cli_key=record.cli_key,
    )


def _apply_domain_to_record(node: OutlineNode, record: OutlineNodeRecord) -> None:
    record.project_id = node.project_id
    record.parent_id = node.parent_id
    record.order_index = node.order_index
    record.cli_key = node.cli_key
    record.title = node.title
    record.summary = node.summary
    record.status = node.status
    record.target_pages = node.target_pages
    record.word_budget = node.word_budget
    record.actual_words = node.actual_words
    record.equation_density_level = node.equation_density_level
    record.math_level = node.math_level
    record.sub_prompt = node.sub_prompt
    record.content_markdown = node.content_markdown
    record.content_latex = node.content_latex
    record.rag_citations = node.rag_citations
    record.reviewer_score = node.reviewer_score
    record.reviewer_notes = node.reviewer_notes
    record.structure_locked = node.structure_locked
    record.updated_at = node.updated_at


class SqlAlchemyOutlineRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def list(self, project_id: uuid.UUID) -> list[OutlineNode]:
        # Soft-deleted nodes never surface through the normal read path -
        # everything above this repository (positions, depth checks, sibling
        # order, tree building) only ever sees live rows.
        result = await self._session.execute(
            select(OutlineNodeRecord)
            .where(
                OutlineNodeRecord.project_id == project_id,
                OutlineNodeRecord.deleted_at.is_(None),
            )
            .order_by(OutlineNodeRecord.order_index)
        )
        return [_to_domain(record) for record in result.scalars().all()]

    async def get(self, node_id: uuid.UUID) -> OutlineNode | None:
        record = await self._session.get(OutlineNodeRecord, node_id)
        if record is None or record.deleted_at is not None:
            return None
        return _to_domain(record)

    async def add(self, node: OutlineNode) -> OutlineNode:
        record = OutlineNodeRecord(id=node.id)
        _apply_domain_to_record(node, record)
        record.created_at = node.created_at
        self._session.add(record)
        await self._session.commit()
        await self._session.refresh(record)
        return _to_domain(record)

    async def update(self, node: OutlineNode) -> OutlineNode:
        record = await self._session.get(OutlineNodeRecord, node.id)
        assert record is not None
        _apply_domain_to_record(node, record)
        await self._session.commit()
        await self._session.refresh(record)
        return _to_domain(record)

    async def delete_subtree(
        self, project_id: uuid.UUID, node_ids: Sequence[uuid.UUID]
    ) -> None:
        """Soft-delete every id in `node_ids` (the caller passes the target
        node plus its whole subtree, via `api.domain.outline.subtree_ids`) -
        never a SQL `DELETE`. The `ON DELETE CASCADE` FKs on this table exist
        for when a *project* is actually hard-deleted, not for this path."""
        if not node_ids:
            return
        await self._session.execute(
            update(OutlineNodeRecord)
            .where(
                OutlineNodeRecord.project_id == project_id,
                OutlineNodeRecord.id.in_(list(node_ids)),
            )
            .values(deleted_at=datetime.now(timezone.utc))
        )
        await self._session.commit()

    async def replace_all(
        self, project_id: uuid.UUID, nodes: Sequence[OutlineNode]
    ) -> list[OutlineNode]:
        # Soft-delete whatever's currently live for this project rather than
        # issuing a SQL DELETE, consistent with `delete_subtree` above - the
        # fresh rows below get new ids, so they never collide with the old
        # (now soft-deleted) ones under the partial unique index.
        await self._session.execute(
            update(OutlineNodeRecord)
            .where(
                OutlineNodeRecord.project_id == project_id,
                OutlineNodeRecord.deleted_at.is_(None),
            )
            .values(deleted_at=datetime.now(timezone.utc))
        )
        records = []
        for node in nodes:
            record = OutlineNodeRecord(id=node.id)
            _apply_domain_to_record(node, record)
            record.created_at = node.created_at
            self._session.add(record)
            records.append(record)
        await self._session.commit()
        for record in records:
            await self._session.refresh(record)
        return [_to_domain(record) for record in records]

    async def reorder(
        self,
        project_id: uuid.UUID,
        parent_id: uuid.UUID | None,
        ordered_ids: Sequence[uuid.UUID],
    ) -> None:
        """Make `ordered_ids` exactly the members (and 0-based order) of the
        `parent_id` sibling group, moving any of them out of their current
        parent if needed. Goes through a temporary, guaranteed-unique
        negative `order_index` per row first, then assigns the final 0..n-1
        values - two statements per row rather than one - so a reorder or a
        parent move can never trip the `(project_id, parent_id, order_index)`
        unique constraint on a backend (SQLite, in tests) that checks it
        immediately rather than only at commit (as the deferrable Postgres
        constraint does).
        """
        if not ordered_ids:
            return
        result = await self._session.execute(
            select(OutlineNodeRecord).where(
                OutlineNodeRecord.project_id == project_id,
                OutlineNodeRecord.id.in_(list(ordered_ids)),
                OutlineNodeRecord.deleted_at.is_(None),
            )
        )
        records_by_id = {record.id: record for record in result.scalars().all()}
        for offset, node_id in enumerate(ordered_ids, start=1):
            record = records_by_id.get(node_id)
            if record is not None:
                record.parent_id = parent_id
                record.order_index = -offset
        await self._session.flush()
        for index, node_id in enumerate(ordered_ids):
            record = records_by_id.get(node_id)
            if record is not None:
                record.order_index = index
        await self._session.commit()

    async def count(self, project_id: uuid.UUID) -> int:
        total = await self._session.scalar(
            select(func.count())
            .select_from(OutlineNodeRecord)
            .where(
                OutlineNodeRecord.project_id == project_id,
                OutlineNodeRecord.deleted_at.is_(None),
            )
        )
        return total or 0
