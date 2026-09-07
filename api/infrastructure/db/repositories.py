from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from api.domain.models import Project
from api.infrastructure.db.models import OutlineNodeRecord, ProjectRecord


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
        return _to_domain(record) if record is not None else None

    async def list(self, limit: int, offset: int) -> tuple[list[Project], int]:
        total = await self._session.scalar(select(func.count()).select_from(ProjectRecord))
        result = await self._session.execute(
            select(ProjectRecord)
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

    async def update(self, project: Project) -> Project:
        record = await self._session.get(ProjectRecord, project.id)
        assert record is not None
        record.title = project.title
        record.subtitle = project.subtitle
        record.authors = project.authors
        record.topic = project.topic
        record.target_audience = project.target_audience
        record.total_pages_budget = project.total_pages_budget
        record.equation_frequency_level = project.equation_frequency_level
        record.do_consider_outline = project.do_consider_outline
        record.do_consider_previous_sections = project.do_consider_previous_sections
        record.output_format = project.output_format
        record.max_outline_levels = project.max_outline_levels
        record.additional_requirements = project.additional_requirements
        record.last_run_id = project.last_run_id
        record.updated_at = project.updated_at
        await self._session.commit()
        return _to_domain(record)

    async def delete(self, project_id: uuid.UUID) -> None:
        record = await self._session.get(ProjectRecord, project_id)
        if record is not None:
            await self._session.delete(record)
            await self._session.commit()

    async def sources_count(self, project_id: uuid.UUID) -> int:
        # No `sources` table yet (issue #5); always 0 until it lands.
        return 0

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
