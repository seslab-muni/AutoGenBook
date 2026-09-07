from __future__ import annotations

from collections.abc import AsyncIterator
from typing import BinaryIO

from api.core.errors import NotFound, StorageError

_CHUNK_SIZE = 64 * 1024


class InMemoryFileStorage:
    """A `FileStorage` fake backed by a plain dict, for tests."""

    def __init__(self) -> None:
        self._objects: dict[str, bytes] = {}
        self.healthy = True

    async def put(
        self,
        key: str,
        stream: BinaryIO,
        content_type: str,
        size_hint: int | None = None,
    ) -> None:
        chunks: list[bytes] = []
        while chunk := stream.read(_CHUNK_SIZE):
            chunks.append(chunk)
        self._objects[key] = b"".join(chunks)

    async def open(self, key: str) -> AsyncIterator[bytes]:
        if key not in self._objects:
            raise NotFound(f"object {key!r} does not exist")
        return self._iter_object(self._objects[key])

    @staticmethod
    async def _iter_object(data: bytes) -> AsyncIterator[bytes]:
        for start in range(0, len(data), _CHUNK_SIZE):
            yield data[start : start + _CHUNK_SIZE]

    async def delete(self, key: str) -> None:
        self._objects.pop(key, None)

    async def exists(self, key: str) -> bool:
        return key in self._objects

    async def healthcheck(self) -> None:
        if not self.healthy:
            raise StorageError("object storage is not reachable")
