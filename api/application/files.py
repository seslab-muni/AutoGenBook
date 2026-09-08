from __future__ import annotations

import hashlib
import mimetypes
import re
import uuid
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from typing import BinaryIO

from fastapi import UploadFile

from api.core.errors import Conflict, NotFound, PayloadTooLarge
from api.core.settings import Settings
from api.domain.models import File, FileKind
from api.domain.ports import FileRepository, FileStorage

# Extensions the CLI's knowledge base indexes (`rag_kb.py:SUPPORTED_EXTS`).
KB_ELIGIBLE_EXTENSIONS = {".pdf", ".docx", ".pptx", ".md", ".txt"}

_UNSAFE_CHARS = re.compile(r"[^A-Za-z0-9._-]+")


def _sanitize_filename(filename: str) -> str:
    name = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1].strip()
    name = _UNSAFE_CHARS.sub("_", name)
    return name or "file"


def _extension(filename: str) -> str:
    dot = filename.rfind(".")
    return filename[dot:].lower() if dot != -1 else ""


def _is_kb_eligible(filename: str) -> bool:
    return _extension(filename) in KB_ELIGIBLE_EXTENSIONS


class _HashingLimitedStream:
    """Wraps an incoming upload's file object: hashes bytes as they are read
    and raises `PayloadTooLarge` as soon as more than `max_bytes` are read,
    so neither `FileStorage` implementation has to duplicate this logic."""

    def __init__(self, source: BinaryIO, max_bytes: int) -> None:
        self._source = source
        self._max_bytes = max_bytes
        self._hasher = hashlib.sha256()
        self.bytes_read = 0

    def read(self, size: int = -1) -> bytes:
        chunk = self._source.read(size)
        if not chunk:
            return chunk
        self.bytes_read += len(chunk)
        if self.bytes_read > self._max_bytes:
            raise PayloadTooLarge(f"upload exceeds the {self._max_bytes} byte limit")
        self._hasher.update(chunk)
        return chunk

    @property
    def sha256(self) -> str:
        return self._hasher.hexdigest()


class FileService:
    def __init__(
        self,
        repository: FileRepository,
        storage: FileStorage,
        settings: Settings,
    ) -> None:
        self._repository = repository
        self._storage = storage
        self._max_bytes = settings.max_upload_mb * 1024 * 1024

    async def upload(self, upload: UploadFile, content_length: int | None = None) -> File:
        # `content_length` is the request's `Content-Length` header (the whole
        # multipart body, not just this field, so it over-counts by the
        # boundary/other-fields overhead) - a cheap upper-bound check that
        # rejects an oversized upload before touching storage at all, instead
        # of only catching it mid-stream via `_HashingLimitedStream` below.
        if content_length is not None and content_length > self._max_bytes:
            raise PayloadTooLarge(f"upload exceeds the {self._max_bytes} byte limit")

        filename = _sanitize_filename(upload.filename or "file")
        content_type = upload.content_type
        if not content_type or content_type == "application/octet-stream":
            guessed, _ = mimetypes.guess_type(filename)
            content_type = guessed or content_type or "application/octet-stream"

        file_id = uuid.uuid4()
        key = f"uploads/{file_id}/{filename}"

        wrapped = _HashingLimitedStream(upload.file, self._max_bytes)
        try:
            await self._storage.put(key, wrapped, content_type)
        except PayloadTooLarge:
            await self._storage.delete(key)
            raise

        file = File(
            id=file_id,
            storage_key=key,
            filename=filename,
            content_type=content_type,
            size_bytes=wrapped.bytes_read,
            sha256=wrapped.sha256,
            kind=FileKind.upload,
            kb_eligible=_is_kb_eligible(filename),
            created_at=datetime.now(timezone.utc),
        )
        try:
            await self._repository.add(file)
        except Exception:
            # `size_bytes`/`sha256` are only known once the upload has
            # already streamed through `storage.put` above, so the DB row
            # can't be written first the way `delete` below reads (issue
            # #59) - the blob necessarily lands in storage before the row
            # does. Compensate on a failed insert by deleting it, so a
            # failed `add` never leaves an orphaned, untracked blob with
            # nothing in the database ever pointing at it (the same
            # "durable record wins" outcome, reached by cleanup on the
            # losing side instead of by reordering the writes).
            await self._storage.delete(key)
            raise
        return file

    async def get(self, file_id: uuid.UUID) -> File:
        file = await self._repository.get(file_id)
        if file is None:
            raise NotFound(f"file {file_id} not found")
        return file

    async def list(
        self, limit: int, offset: int, *, kind: FileKind | None = None
    ) -> tuple[list[File], int]:
        items, total = await self._repository.list(limit, offset, kind=kind)
        return list(items), total

    async def delete(self, file_id: uuid.UUID) -> None:
        file = await self.get(file_id)
        if await self._repository.is_referenced(file_id):
            raise Conflict(f"file {file_id} is still referenced")
        # DB row first, blob after: `is_referenced` already ignores
        # soft-deleted sources, but the FK on `project_sources.file_id` is
        # `RESTRICT`, so a row this check missed (a real bug, or a race with
        # a fresh reference) makes the delete fail here instead of after the
        # blob is already gone - a failed delete never leaves a `files` row
        # whose content 404s and can never be cleaned up.
        await self._repository.delete(file)
        await self._storage.delete(file.storage_key)

    async def open_content(self, file_id: uuid.UUID) -> tuple[File, AsyncIterator[bytes]]:
        file = await self.get(file_id)
        chunks = await self._storage.open(file.storage_key)
        return file, chunks
