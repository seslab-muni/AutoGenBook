from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import datetime, timezone

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from api.core.errors import Conflict, NotFound
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


_ALL_MUTABLE_FIELDS = (
    "project_id",
    "parent_id",
    "order_index",
    "cli_key",
    "title",
    "summary",
    "status",
    "target_pages",
    "word_budget",
    "actual_words",
    "equation_density_level",
    "math_level",
    "sub_prompt",
    "content_markdown",
    "content_latex",
    "rag_citations",
    "reviewer_score",
    "reviewer_notes",
    "structure_locked",
)


def _apply_domain_to_record(
    node: OutlineNode, record: OutlineNodeRecord, *, fields: Sequence[str] | None = None
) -> None:
    """Copy `node`'s columns onto `record`. `fields`, when given, limits
    this to just those attributes (plus `updated_at`, always) instead of
    every column - so two concurrent updates to different fields of the
    same node (e.g. a debounced content autosave racing a `structureLocked`
    toggle, issue #56) don't each overwrite the other's change with their
    own stale copy of it."""
    names = _ALL_MUTABLE_FIELDS if fields is None else fields
    for name in names:
        setattr(record, name, getattr(node, name))
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

    async def _assert_live_parent(self, parent_id: uuid.UUID | None) -> None:
        """Re-check the parent inside this call rather than trusting a
        `flat` snapshot the caller (e.g. `OutlineService.create`) read
        earlier - a concurrent `DELETE /outline/{parent}` landing between
        that read and this write would otherwise leave a live child under a
        soft-deleted parent, which is exactly the state that used to 500
        every subsequent outline/project read (issue #75)."""
        if parent_id is None:
            return
        parent = await self._session.get(OutlineNodeRecord, parent_id)
        if parent is None or parent.deleted_at is not None:
            raise NotFound(f"parent node {parent_id} does not exist")

    async def add(self, node: OutlineNode) -> OutlineNode:
        await self._assert_live_parent(node.parent_id)
        record = OutlineNodeRecord(id=node.id)
        _apply_domain_to_record(node, record)
        record.created_at = node.created_at
        self._session.add(record)
        try:
            await self._session.commit()
        except IntegrityError as exc:
            # Backstop for a concurrent insert/reorder racing this one past
            # `OutlineService.create`'s own check-then-shift logic - the
            # partial unique index (`uq_outline_nodes_project_parent_order`)
            # is the actual source of truth. Surface it as a normal
            # conflict instead of the generic 500 an unhandled
            # `IntegrityError` used to produce (issue #67), mirroring
            # `SqlAlchemyRunRepository.add`'s handling of `uq_runs_project_active`.
            await self._session.rollback()
            raise Conflict(
                f"node {node.id} collides with an existing sibling position"
            ) from exc
        await self._session.refresh(record)
        return _to_domain(record)

    async def update(
        self, node: OutlineNode, *, fields: Sequence[str] | None = None
    ) -> OutlineNode:
        await self._assert_live_parent(node.parent_id)
        record = await self._session.get(OutlineNodeRecord, node.id)
        if record is None:
            # The row disappeared between the caller's read and this write
            # (e.g. a concurrent hard delete) - a proper `NotFound` (404)
            # instead of a bare `AssertionError` (a 500 that, under
            # `python -O`, disappears entirely and lets the next line raise
            # a confusing `AttributeError` instead; issue #62).
            raise NotFound(f"outline node {node.id} does not exist")
        _apply_domain_to_record(node, record, fields=fields)
        await self._session.commit()
        await self._session.refresh(record)
        return _to_domain(record)

    async def delete_subtree(self, project_id: uuid.UUID, root_id: uuid.UUID) -> None:
        """Soft-delete `root_id` and every live descendant reachable from it
        - never a SQL `DELETE`. The `ON DELETE CASCADE` FKs on this table
        exist for when a *project* is actually hard-deleted, not for this
        path.

        The descendant set is recomputed here with a recursive CTE rather
        than trusting a precomputed id list from the caller's `flat`
        snapshot: a child inserted under `root_id` after that snapshot was
        read (e.g. a concurrent `POST /outline`, or the worker's
        `import_graph` subdividing a node) would otherwise survive as a live
        row under a now-deleted parent - the same bricked state issue #75
        also closes off in `assign_positions`/`add`/`update`.
        """
        anchor = select(OutlineNodeRecord.id, OutlineNodeRecord.parent_id).where(
            OutlineNodeRecord.project_id == project_id,
            OutlineNodeRecord.id == root_id,
            OutlineNodeRecord.deleted_at.is_(None),
        )
        subtree = anchor.cte("outline_subtree", recursive=True)
        children = select(
            OutlineNodeRecord.id, OutlineNodeRecord.parent_id
        ).where(
            OutlineNodeRecord.project_id == project_id,
            OutlineNodeRecord.deleted_at.is_(None),
            OutlineNodeRecord.parent_id == subtree.c.id,
        )
        subtree = subtree.union_all(children)
        await self._session.execute(
            update(OutlineNodeRecord)
            .where(OutlineNodeRecord.id.in_(select(subtree.c.id)))
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
