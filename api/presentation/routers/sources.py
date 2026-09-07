from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status

from api.application.sources import SourceService
from api.core.db import get_session
from api.infrastructure.db.file_repository import SqlAlchemyFileRepository
from api.infrastructure.db.repositories import SqlAlchemyProjectRepository
from api.infrastructure.db.source_repository import SqlAlchemySourceRepository
from api.presentation.schemas.common import Page, PageParams
from api.presentation.schemas.sources import Source, SourceCreate, SourceUpdate, source_to_schema

router = APIRouter(prefix="/projects/{project_id}/sources", tags=["sources"])


def get_source_service(session: AsyncSession = Depends(get_session)) -> SourceService:
    return SourceService(
        project_repository=SqlAlchemyProjectRepository(session),
        file_repository=SqlAlchemyFileRepository(session),
        source_repository=SqlAlchemySourceRepository(session),
    )


@router.get("", response_model=Page[Source])
async def list_sources(
    project_id: uuid.UUID,
    params: PageParams = Depends(),
    service: SourceService = Depends(get_source_service),
) -> Page[Source]:
    rows, total = await service.list(project_id, limit=params.limit, offset=params.offset)
    return Page[Source](
        items=[source_to_schema(source, file) for source, file in rows],
        total=total,
        limit=params.limit,
        offset=params.offset,
    )


@router.post("", response_model=Source, status_code=status.HTTP_201_CREATED)
async def add_source(
    project_id: uuid.UUID,
    body: SourceCreate,
    service: SourceService = Depends(get_source_service),
) -> Source:
    source, file = await service.add(
        project_id,
        file_id=body.file_id,
        source_type=body.type,
        authors=body.authors,
        year=body.year,
        doi=body.doi,
        url=body.url,
        description=body.description,
    )
    return source_to_schema(source, file)


@router.get("/{source_id}", response_model=Source)
async def get_source(
    project_id: uuid.UUID,
    source_id: uuid.UUID,
    service: SourceService = Depends(get_source_service),
) -> Source:
    source, file = await service.get(project_id, source_id)
    return source_to_schema(source, file)


@router.patch("/{source_id}", response_model=Source)
async def update_source(
    project_id: uuid.UUID,
    source_id: uuid.UUID,
    body: SourceUpdate,
    service: SourceService = Depends(get_source_service),
) -> Source:
    changes = body.model_dump(exclude_unset=True)
    source, file = await service.update(project_id, source_id, changes)
    return source_to_schema(source, file)


@router.delete("/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_source(
    project_id: uuid.UUID,
    source_id: uuid.UUID,
    service: SourceService = Depends(get_source_service),
) -> None:
    await service.remove(project_id, source_id)
