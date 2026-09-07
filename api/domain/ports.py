from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Sequence
from typing import BinaryIO, Protocol

from api.domain.models import File


class FileStorage(Protocol):
    async def put(
        self,
        key: str,
        stream: BinaryIO,
        content_type: str,
        size_hint: int | None = None,
    ) -> None: ...

    async def open(self, key: str) -> AsyncIterator[bytes]: ...

    async def delete(self, key: str) -> None: ...

    async def exists(self, key: str) -> bool: ...

    async def healthcheck(self) -> None: ...


class FileRepository(Protocol):
    async def add(self, file: File) -> None: ...

    async def get(self, file_id: uuid.UUID) -> File | None: ...

    async def list(self, limit: int, offset: int) -> tuple[Sequence[File], int]: ...

    async def delete(self, file: File) -> None: ...

    async def is_referenced(self, file_id: uuid.UUID) -> bool: ...
