from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from api.application.outline import OutlineService
from api.application.projects import ProjectService
from api.core.db import get_session
from api.domain.models import Project as ProjectDomain
from api.infrastructure.db.repositories import SqlAlchemyProjectRepository
from api.presentation.deps import get_outline_service
from api.presentation.routers.outline import tree_to_schema
from api.presentation.schemas.common import Page, PageParams
from api.presentation.schemas.outline import OutlineNodeTree
from api.presentation.schemas.projects import (
    Project,
    ProjectCreate,
    ProjectSummary,
    ProjectUpdate,
)

router = APIRouter(prefix="/projects", tags=["projects"])


async def current_owner() -> uuid.UUID | None:
    # No auth yet; ownership filtering switches on later without route changes.
    return None


def get_project_service(session: AsyncSession = Depends(get_session)) -> ProjectService:
    return ProjectService(SqlAlchemyProjectRepository(session))


async def _outline_tree(
    project_id: uuid.UUID, outline_service: OutlineService
) -> list[OutlineNodeTree]:
    tree, _total = await outline_service.list(project_id, format="tree")
    return [tree_to_schema(entry) for entry in tree]


def _to_schema(project: ProjectDomain, outline: list[OutlineNodeTree]) -> Project:
    return Project(
        id=project.id,
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
        sources=[],
        outline=outline,
        last_run_id=project.last_run_id,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


@router.get("", response_model=Page[ProjectSummary])
async def list_projects(
    params: PageParams = Depends(),
    service: ProjectService = Depends(get_project_service),
) -> Page[ProjectSummary]:
    summaries, total = await service.list(limit=params.limit, offset=params.offset)
    return Page[ProjectSummary](
        items=[ProjectSummary.model_validate(summary) for summary in summaries],
        total=total,
        limit=params.limit,
        offset=params.offset,
    )


@router.post("", response_model=Project, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: ProjectCreate,
    owner_id: uuid.UUID | None = Depends(current_owner),
    service: ProjectService = Depends(get_project_service),
    outline_service: OutlineService = Depends(get_outline_service),
) -> Project:
    fields = body.model_dump(exclude={"outline"})
    project = await service.create(owner_id=owner_id, **fields)
    wizard_outline = body.outline
    outline: list[OutlineNodeTree] = []
    if wizard_outline is not None:
        tree = [entry.model_dump() for entry in wizard_outline]
        await outline_service.replace(project.id, tree)
        outline = await _outline_tree(project.id, outline_service)
    return _to_schema(project, outline)


@router.get("/{project_id}", response_model=Project)
async def get_project(
    project_id: uuid.UUID,
    service: ProjectService = Depends(get_project_service),
    outline_service: OutlineService = Depends(get_outline_service),
) -> Project:
    project = await service.get(project_id)
    outline = await _outline_tree(project_id, outline_service)
    return _to_schema(project, outline)


@router.patch("/{project_id}", response_model=Project)
async def update_project(
    project_id: uuid.UUID,
    body: ProjectUpdate,
    service: ProjectService = Depends(get_project_service),
    outline_service: OutlineService = Depends(get_outline_service),
) -> Project:
    changes = body.model_dump(exclude_unset=True)
    project = await service.update(project_id, changes)
    outline = await _outline_tree(project_id, outline_service)
    return _to_schema(project, outline)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: uuid.UUID,
    service: ProjectService = Depends(get_project_service),
) -> Response:
    await service.delete(project_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{project_id}/duplicate", response_model=Project, status_code=status.HTTP_201_CREATED
)
async def duplicate_project(
    project_id: uuid.UUID,
    service: ProjectService = Depends(get_project_service),
    outline_service: OutlineService = Depends(get_outline_service),
) -> Project:
    project = await service.duplicate(project_id)
    await outline_service.duplicate_from(project_id, project.id)
    outline = await _outline_tree(project.id, outline_service)
    return _to_schema(project, outline)
