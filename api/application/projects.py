from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from api.core.errors import NotFound
from api.domain.models import OutputFormat, Project, ProjectSummary, TargetAudience
from api.domain.ports import ProjectRepository


class ProjectService:
    def __init__(self, repository: ProjectRepository) -> None:
        self._repository = repository

    async def create(
        self,
        *,
        owner_id: uuid.UUID | None,
        title: str,
        subtitle: str,
        authors: list[str],
        topic: str,
        target_audience: TargetAudience,
        total_pages_budget: int,
        equation_frequency_level: int,
        do_consider_outline: bool,
        do_consider_previous_sections: bool,
        output_format: OutputFormat,
        max_outline_levels: int,
        additional_requirements: str | None,
    ) -> Project:
        now = datetime.now(timezone.utc)
        project = Project(
            id=uuid.uuid4(),
            owner_id=owner_id,
            title=title,
            subtitle=subtitle,
            authors=list(authors),
            topic=topic,
            target_audience=target_audience,
            total_pages_budget=total_pages_budget,
            equation_frequency_level=equation_frequency_level,
            do_consider_outline=do_consider_outline,
            do_consider_previous_sections=do_consider_previous_sections,
            output_format=output_format,
            max_outline_levels=max_outline_levels,
            additional_requirements=additional_requirements,
            last_run_id=None,
            created_at=now,
            updated_at=now,
        )
        return await self._repository.add(project)

    async def get(self, project_id: uuid.UUID) -> Project:
        project = await self._repository.get(project_id)
        if project is None:
            raise NotFound(f"project {project_id} does not exist")
        return project

    async def list(self, *, limit: int, offset: int) -> tuple[list[ProjectSummary], int]:
        projects, total = await self._repository.list(limit=limit, offset=offset)
        summaries = [
            ProjectSummary(
                id=project.id,
                title=project.title,
                subtitle=project.subtitle,
                authors=project.authors,
                topic=project.topic,
                target_audience=project.target_audience,
                total_pages_budget=project.total_pages_budget,
                sources_count=await self._repository.sources_count(project.id),
                outline_node_count=await self._repository.outline_node_count(project.id),
                last_run_id=project.last_run_id,
                created_at=project.created_at,
                updated_at=project.updated_at,
            )
            for project in projects
        ]
        return summaries, total

    async def update(self, project_id: uuid.UUID, changes: dict[str, Any]) -> Project:
        project = await self.get(project_id)
        for field_name, value in changes.items():
            setattr(project, field_name, value)
        project.updated_at = datetime.now(timezone.utc)
        return await self._repository.update(project)

    async def delete(self, project_id: uuid.UUID) -> None:
        await self.get(project_id)
        await self._repository.delete(project_id)

    async def duplicate(self, project_id: uuid.UUID) -> Project:
        source = await self.get(project_id)
        now = datetime.now(timezone.utc)
        # `sources`/`outline` don't exist yet (issues #5/#6); once they do,
        # this is where the duplicate should copy sources by reference and
        # deep-copy outline nodes alongside the metadata below.
        duplicate = Project(
            id=uuid.uuid4(),
            owner_id=source.owner_id,
            title=f"{source.title} (Copy)",
            subtitle=source.subtitle,
            authors=list(source.authors),
            topic=source.topic,
            target_audience=source.target_audience,
            total_pages_budget=source.total_pages_budget,
            equation_frequency_level=source.equation_frequency_level,
            do_consider_outline=source.do_consider_outline,
            do_consider_previous_sections=source.do_consider_previous_sections,
            output_format=source.output_format,
            max_outline_levels=source.max_outline_levels,
            additional_requirements=source.additional_requirements,
            last_run_id=None,
            created_at=now,
            updated_at=now,
        )
        return await self._repository.add(duplicate)
