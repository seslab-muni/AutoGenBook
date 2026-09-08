from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from api.core.settings import Settings, get_settings
from api.domain.models import File, FileKind
from api.infrastructure.db.file_repository import SqlAlchemyFileRepository
from api.infrastructure.storage.memory import InMemoryFileStorage


async def _upload(
    client: AsyncClient, filename: str, content: bytes, content_type: str = "text/plain"
):
    return await client.post(
        "/api/v1/files", files={"file": (filename, content, content_type)}
    )


async def test_upload_list_get_download_delete_round_trip(
    client: AsyncClient, file_storage: InMemoryFileStorage
) -> None:
    content = b"hello world, this is a test file"
    expected_sha256 = hashlib.sha256(content).hexdigest()

    upload_response = await _upload(client, "notes.txt", content, "text/plain")
    assert upload_response.status_code == 201
    body = upload_response.json()
    assert body["filename"] == "notes.txt"
    assert body["contentType"] == "text/plain"
    assert body["sizeBytes"] == len(content)
    assert body["sha256"] == expected_sha256
    assert body["kind"] == "upload"
    assert body["kbEligible"] is True
    file_id = body["id"]

    assert await file_storage.exists(f"uploads/{file_id}/notes.txt")

    list_response = await client.get("/api/v1/files")
    assert list_response.status_code == 200
    page = list_response.json()
    assert page["total"] == 1
    assert page["limit"] == 50
    assert page["offset"] == 0
    assert [item["id"] for item in page["items"]] == [file_id]

    get_response = await client.get(f"/api/v1/files/{file_id}")
    assert get_response.status_code == 200
    assert get_response.json() == body

    download_response = await client.get(f"/api/v1/files/{file_id}/content")
    assert download_response.status_code == 200
    assert download_response.content == content
    assert download_response.headers["etag"] == f'"{expected_sha256}"'
    assert download_response.headers["content-length"] == str(len(content))
    assert "notes.txt" in download_response.headers["content-disposition"]
    assert download_response.headers["content-disposition"].startswith(
        "attachment; filename*=UTF-8''"
    )

    delete_response = await client.delete(f"/api/v1/files/{file_id}")
    assert delete_response.status_code == 204

    assert not await file_storage.exists(f"uploads/{file_id}/notes.txt")
    assert (await client.get(f"/api/v1/files/{file_id}")).status_code == 404

    empty_list = await client.get("/api/v1/files")
    assert empty_list.json()["total"] == 0


async def test_list_files_filters_by_kind(
    client: AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """Regression for issue #61: `GET /files` had no way to exclude run
    artifacts from the upload picker's own file listing - add an optional
    `kind` filter."""
    upload_response = await _upload(client, "notes.txt", b"hello", "text/plain")
    assert upload_response.status_code == 201
    upload_id = upload_response.json()["id"]

    async with session_factory() as session:
        await SqlAlchemyFileRepository(session).add(
            File(
                id=uuid.uuid4(),
                storage_key="runs/some-run/out/book.md",
                filename="book.md",
                content_type="text/markdown",
                size_bytes=3,
                sha256="1" * 64,
                kind=FileKind.artifact,
                kb_eligible=False,
                created_at=datetime.now(timezone.utc),
            )
        )

    unfiltered = await client.get("/api/v1/files")
    assert unfiltered.json()["total"] == 2

    uploads_only = await client.get("/api/v1/files", params={"kind": "upload"})
    assert uploads_only.json()["total"] == 1
    assert [item["id"] for item in uploads_only.json()["items"]] == [upload_id]

    artifacts_only = await client.get("/api/v1/files", params={"kind": "artifact"})
    assert artifacts_only.json()["total"] == 1
    assert artifacts_only.json()["items"][0]["filename"] == "book.md"


async def test_get_missing_file_returns_404(client: AsyncClient) -> None:
    response = await client.get("/api/v1/files/00000000-0000-0000-0000-000000000000")
    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"


async def test_delete_missing_file_returns_404(client: AsyncClient) -> None:
    response = await client.delete("/api/v1/files/00000000-0000-0000-0000-000000000000")
    assert response.status_code == 404


async def test_kb_eligible_extensions(client: AsyncClient) -> None:
    for filename, expected in [
        ("book.pdf", True),
        ("report.docx", True),
        ("slides.pptx", True),
        ("notes.md", True),
        ("readme.txt", True),
        ("refs.bib", False),
        ("archive.zip", False),
    ]:
        response = await _upload(
            client, filename, b"content", "application/octet-stream"
        )
        assert response.status_code == 201
        assert response.json()["kbEligible"] is expected, filename


async def test_upload_falls_back_to_guessed_content_type(client: AsyncClient) -> None:
    response = await _upload(client, "diagram.md", b"# hi", "application/octet-stream")
    assert response.status_code == 201
    assert response.json()["contentType"] == "text/markdown"


async def test_upload_over_max_size_returns_413_and_leaves_no_object(
    client: AsyncClient, app: FastAPI, file_storage: InMemoryFileStorage
) -> None:
    app.dependency_overrides[get_settings] = lambda: Settings(max_upload_mb=0)
    try:
        response = await _upload(client, "big.txt", b"more than zero bytes")
    finally:
        del app.dependency_overrides[get_settings]

    assert response.status_code == 413
    assert response.headers["content-type"] == "application/problem+json"

    list_response = await client.get("/api/v1/files")
    assert list_response.json()["total"] == 0
    assert file_storage._objects == {}


async def test_upload_over_max_size_rejected_by_content_length_never_touches_storage(
    client: AsyncClient, app: FastAPI, file_storage: InMemoryFileStorage, monkeypatch
) -> None:
    put_calls = 0
    original_put = file_storage.put

    async def counting_put(*args, **kwargs):
        nonlocal put_calls
        put_calls += 1
        return await original_put(*args, **kwargs)

    monkeypatch.setattr(file_storage, "put", counting_put)
    app.dependency_overrides[get_settings] = lambda: Settings(max_upload_mb=0)
    try:
        response = await _upload(client, "big.txt", b"more than zero bytes")
    finally:
        del app.dependency_overrides[get_settings]

    assert response.status_code == 413
    assert put_calls == 0
    assert file_storage._objects == {}


async def test_download_content_sets_nosniff_header(client: AsyncClient) -> None:
    """issue #59: `get_file_content` reflects the uploader-supplied
    `content_type` straight back as the response's `Content-Type` - without
    `X-Content-Type-Options: nosniff`, a browser sniffing the body instead
    of trusting a mismatched type is the exact MIME-sniffing vector this
    header exists to shut off."""
    upload_response = await _upload(client, "notes.txt", b"hello", "text/plain")
    file_id = upload_response.json()["id"]

    response = await client.get(f"/api/v1/files/{file_id}/content")
    assert response.status_code == 200
    assert response.headers["x-content-type-options"] == "nosniff"


async def test_upload_leaves_no_orphaned_blob_when_the_db_insert_fails(
    client: AsyncClient, monkeypatch, file_storage: InMemoryFileStorage
) -> None:
    """issue #59: `FileService.upload` necessarily writes the blob to
    storage before it can insert the `files` row (the row needs the
    upload's own computed `sha256`/`size_bytes`) - a failed insert must not
    leave that blob behind with nothing in the database ever pointing at
    it, or it's an orphan that consumes storage forever with no way for any
    future cleanup job to even find it (nothing references its key)."""

    async def fake_add(self: SqlAlchemyFileRepository, file):
        raise RuntimeError("db insert failed")

    monkeypatch.setattr(SqlAlchemyFileRepository, "add", fake_add)

    # `ASGITransport`'s default `raise_app_exceptions=True` re-raises an
    # exception that reached no handler instead of returning it as a 500
    # response - the point of this test is what happens to the already-
    # uploaded blob, not the HTTP status code.
    with pytest.raises(RuntimeError, match="db insert failed"):
        await _upload(client, "notes.txt", b"hello world")

    assert file_storage._objects == {}


async def test_delete_returns_409_when_file_is_referenced(
    client: AsyncClient, monkeypatch
) -> None:
    async def fake_is_referenced(self: SqlAlchemyFileRepository, file_id) -> bool:
        return True

    monkeypatch.setattr(SqlAlchemyFileRepository, "is_referenced", fake_is_referenced)

    upload_response = await _upload(client, "referenced.txt", b"data")
    file_id = upload_response.json()["id"]

    response = await client.delete(f"/api/v1/files/{file_id}")
    assert response.status_code == 409
    assert response.headers["content-type"] == "application/problem+json"


async def test_ready_v1_checks_object_storage_healthcheck(
    client: AsyncClient, file_storage: InMemoryFileStorage
) -> None:
    file_storage.healthy = False
    response = await client.get("/api/v1/ready")
    assert response.status_code == 503
    assert response.json()["title"] == "Service Unavailable"
