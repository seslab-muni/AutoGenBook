from __future__ import annotations

import uuid
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query, UploadFile
from fastapi import File as FastAPIFile
from fastapi.responses import StreamingResponse
from starlette import status

from api.application.files import FileService
from api.presentation.deps import get_file_service
from api.presentation.schemas.common import Page
from api.presentation.schemas.files import File as FileSchema

router = APIRouter(prefix="/files", tags=["files"])


@router.post("", status_code=status.HTTP_201_CREATED, response_model=FileSchema)
async def upload_file(
    file: UploadFile = FastAPIFile(...),
    service: FileService = Depends(get_file_service),
):
    return await service.upload(file)


@router.get("", response_model=Page[FileSchema])
async def list_files(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    service: FileService = Depends(get_file_service),
):
    items, total = await service.list(limit=limit, offset=offset)
    return Page[FileSchema](items=items, total=total, limit=limit, offset=offset)


@router.get("/{file_id}", response_model=FileSchema)
async def get_file(
    file_id: uuid.UUID,
    service: FileService = Depends(get_file_service),
):
    return await service.get(file_id)


@router.get("/{file_id}/content")
async def get_file_content(
    file_id: uuid.UUID,
    service: FileService = Depends(get_file_service),
):
    file, chunks = await service.open_content(file_id)
    filename = quote(file.filename)
    headers = {
        "Content-Disposition": f"attachment; filename*=UTF-8''{filename}",
        "Content-Length": str(file.size_bytes),
        "ETag": f'"{file.sha256}"',
    }
    return StreamingResponse(chunks, media_type=file.content_type, headers=headers)


@router.delete("/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_file(
    file_id: uuid.UUID,
    service: FileService = Depends(get_file_service),
) -> None:
    await service.delete(file_id)
