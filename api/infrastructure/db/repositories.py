from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import datetime, timezone

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from api.domain.models import Project
from api.infrastructure.db.models import OutlineNodeRecord, ProjectRecord, SourceRecord

_ALL_MUTABLE_FIELDS = (
    "title",
    "subtitle",
    "authors",
    "topic",
    "target_audience",
    "total_pages_budget",
    "equation_frequency_level",
    "do_consider_outline",
    "do_consider_previous_sections",
    "output_format",
    "max_outline_levels",
    "additional_requirements",
    "last_run_id",
)


def _as_aware_utc(value: datetime) -> datetime:
    # All timestamps are written in UTC; SQLite (unlike Postgres) drops the
    # tzinfo on round-trip, so re-attach it for consistent serialization.
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _to_domain(record: ProjectRecord) -> Project:
    return Project(
        id=record.id,
        owner_id=record.owner_id,
        title=record.title,
        subtitle=record.subtitle,
        authors=list(record.authors),
        topic=record.topic,
        target_audience=record.target_audience,
        total_pages_budget=record.total_pages_budget,
        equation_frequency_level=record.equation_frequency_level,
        do_consider_outline=record.do_consider_outline,
        do_consider_previous_sections=record.do_consider_previous_sections,
        output_format=record.output_format,
        max_outline_levels=record.max_outline_levels,
        additional_requirements=record.additional_requirements,
        last_run_id=record.last_run_id,
        created_at=_as_aware_utc(record.created_at),
        updated_at=_as_aware_utc(record.updated_at),
    )


class SqlAlchemyProjectRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get(self, project_id: uuid.UUID) -> Project | None:
        record = await self._session.get(ProjectRecord, project_id)
        if record is None or record.deleted_at is not None:
            return None
        return _to_domain(record)

    async def list(self, limit: int, offset: int) -> tuple[list[Project], int]:
        total = await self._session.scalar(
            select(func.count())
            .select_from(ProjectRecord)
            .where(ProjectRecord.deleted_at.is_(None))
        )
        result = await self._session.execute(
            select(ProjectRecord)
            .where(ProjectRecord.deleted_at.is_(None))
            .order_by(ProjectRecord.updated_at.desc())
            .limit(limit)
            .offset(offset)
        )
        records = result.scalars().all()
        return [_to_domain(record) for record in records], total or 0

    async def add(self, project: Project) -> Project:
        record = ProjectRecord(
            id=project.id,
            owner_id=project.owner_id,
            title=project.title,
            subtitle=project.subtitle,
            authors=project.authors,
            topic=project.topic,
            target_audience=project.target_audience,
            total_pages_budget=project.total_pages_budget,
            equation_frequency_level=project.equation_frequency_level,
            do_consider_outline=project.do_consider_outline,
            do_consider_previous_sections=project.do_consider_previous_sections,
            output_format=project.output_format,
            max_outline_levels=project.max_outline_levels,
            additional_requirements=project.additional_requirements,
            last_run_id=project.last_run_id,
            created_at=project.created_at,
            updated_at=project.updated_at,
        )
        self._session.add(record)
        await self._session.commit()
        return _to_domain(record)

    async def update(
        self, project: Project, *, fields: Sequence[str] | None = None
    ) -> Project:
        """`fields`, when given, writes only those columns (plus
        `updated_at`, always) instead of the whole row - `RunService.
        create`/`GenerationService._import_graph` bumping `last_run_id`
        only, for instance, so it can't silently revert a concurrent
        `PATCH /projects/{id}` that read the project in between (issue
        #56)."""
        record = await self._session.get(ProjectRecord, project.id)
        assert record is not None
        for name in _ALL_MUTABLE_FIELDS if fields is None else fields:
            setattr(record, name, getattr(project, name))
        record.updated_at = project.updated_at
        await self._session.commit()
        return _to_domain(record)

    async def delete(self, project_id: uuid.UUID) -> None:
        # Soft delete (issue #57): never a SQL `DELETE`, so the project's
        # `runs` (and `run_artifacts`/`run_events` cascading from them)
        # survive - a hard delete used to cascade those away, permanently
        # orphaning the run's work directory on disk with nothing left in
        # the database for `sweep_stale_work_dirs`/`sweep_orphaned_work_dirs`
        # to ever find it by.
        now = datetime.now(timezone.utc)
        # Cascade the soft delete onto the project's own sources, the same
        # way `SourceService.remove` soft-deletes one (`deleted_at` set,
        # `file_id` nulled so the `RESTRICT` FK on `project_sources.file_id`
        # no longer blocks deleting a file this project no longer
        # references) - preserving the pre-soft-delete contract that
        # deleting a project frees up its attached files for deletion,
        # instead of leaving their source rows "live" forever under a
        # project that's no longer reachable through the API.
        await self._session.execute(
            update(SourceRecord)
            .where(SourceRecord.project_id == project_id, SourceRecord.deleted_at.is_(None))
            .values(deleted_at=now, file_id=None)
        )
        await self._session.execute(
            update(ProjectRecord)
            .where(ProjectRecord.id == project_id, ProjectRecord.deleted_at.is_(None))
            .values(deleted_at=now)
        )
        await self._session.commit()

    async def sources_count(self, project_id: uuid.UUID) -> int:
        total = await self._session.scalar(
            select(func.count())
            .select_from(SourceRecord)
            .where(SourceRecord.project_id == project_id, SourceRecord.deleted_at.is_(None))
        )
        return total or 0

    async def outline_node_count(self, project_id: uuid.UUID) -> int:
        total = await self._session.scalar(
            select(func.count())
            .select_from(OutlineNodeRecord)
            .where(
                OutlineNodeRecord.project_id == project_id,
                OutlineNodeRecord.deleted_at.is_(None),
            )
        )
        return total or 0
