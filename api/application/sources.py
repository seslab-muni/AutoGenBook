from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from api.core.errors import Conflict, NotFound, ValidationFailed
from api.domain.models import File, Source, SourceStatus, SourceType
from api.domain.ports import FileRepository, ProjectRepository, SourceRepository

# Mirrors the frontend mock's `EXTENSION_SOURCE_TYPE` (app/src/mocks/handlers.ts) and
# the extensions the CLI's knowledge base indexes (`FileService.KB_ELIGIBLE_EXTENSIONS`).
_EXTENSION_SOURCE_TYPE: dict[str, SourceType] = {
    ".pdf": SourceType.pdf,
    ".docx": SourceType.doc,
    ".pptx": SourceType.ppt,
    ".md": SourceType.md,
    ".txt": SourceType.txt,
}


def _infer_source_type(filename: str) -> SourceType:
    dot = filename.rfind(".")
    extension = filename[dot:].lower() if dot != -1 else ""
    return _EXTENSION_SOURCE_TYPE.get(extension, SourceType.notes)


class SourceService:
    def __init__(
        self,
        project_repository: ProjectRepository,
        file_repository: FileRepository,
        source_repository: SourceRepository,
    ) -> None:
        self._projects = project_repository
        self._files = file_repository
        self._sources = source_repository

    async def _require_project(self, project_id: uuid.UUID) -> None:
        project = await self._projects.get(project_id)
        if project is None:
            raise NotFound(f"project {project_id} does not exist")

    async def _require_file(self, file_id: uuid.UUID) -> File:
        file = await self._files.get(file_id)
        if file is None:
            raise NotFound(f"file {file_id} does not exist")
        return file

    async def add(
        self,
        project_id: uuid.UUID,
        *,
        file_id: uuid.UUID,
        source_type: SourceType | None = None,
        authors: str | None = None,
        year: str | None = None,
        doi: str | None = None,
        url: str | None = None,
        description: str | None = None,
    ) -> tuple[Source, File]:
        await self._require_project(project_id)
        file = await self._require_file(file_id)
        if not file.kb_eligible:
            raise ValidationFailed(
                f"file {file_id} is not eligible for the knowledge base "
                f"(kbEligible=false for '{file.filename}')"
            )
        existing = await self._sources.get_by_project_and_file(project_id, file_id)
        if existing is not None:
            raise Conflict(f"file {file_id} is already attached to project {project_id}")

        source = Source(
            id=uuid.uuid4(),
            project_id=project_id,
            file_id=file_id,
            source_type=source_type or _infer_source_type(file.filename),
            authors=authors,
            year=year,
            doi=doi,
            url=url,
            description=description,
            chunks_count=None,
            status=SourceStatus.ready,
            created_at=datetime.now(timezone.utc),
        )
        source = await self._sources.add(source)
        return source, file

    async def list(
        self, project_id: uuid.UUID, *, limit: int, offset: int
    ) -> tuple[list[tuple[Source, File]], int]:
        await self._require_project(project_id)
        sources, total = await self._sources.list(project_id, limit, offset)
        rows = [(source, await self._require_file(source.file_id)) for source in sources]
        return rows, total

    async def list_for_embed(self, project_id: uuid.UUID) -> list[tuple[Source, File]]:
        # Used to embed the full `sources` array on a `Project` response; the
        # caller has already resolved the project, so no existence check here.
        sources = await self._sources.list_all(project_id)
        return [(source, await self._require_file(source.file_id)) for source in sources]

    async def get(self, project_id: uuid.UUID, source_id: uuid.UUID) -> tuple[Source, File]:
        await self._require_project(project_id)
        source = await self._sources.get(project_id, source_id)
        if source is None:
            raise NotFound(f"source {source_id} does not exist")
        file = await self._require_file(source.file_id)
        return source, file

    async def update(
        self, project_id: uuid.UUID, source_id: uuid.UUID, changes: dict[str, Any]
    ) -> tuple[Source, File]:
        source, file = await self.get(project_id, source_id)
        for field_name, value in changes.items():
            setattr(source, field_name, value)
        source = await self._sources.update(source)
        return source, file

    async def remove(self, project_id: uuid.UUID, source_id: uuid.UUID) -> None:
        source, _file = await self.get(project_id, source_id)
        await self._sources.delete(source)
