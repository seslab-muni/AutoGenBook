from __future__ import annotations

import uuid

from httpx import AsyncClient

PROJECT_PAYLOAD = {
    "title": "Widgets 101",
    "subtitle": "An Introduction",
    "authors": ["Ada Lovelace"],
    "topic": "widgets",
}


async def _create_project(client: AsyncClient, **overrides) -> dict:
    payload = {**PROJECT_PAYLOAD, **overrides}
    response = await client.post("/api/v1/projects", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def _upload_file(
    client: AsyncClient,
    filename: str,
    content: bytes = b"content",
    content_type: str = "application/octet-stream",
) -> dict:
    response = await client.post(
        "/api/v1/files", files={"file": (filename, content, content_type)}
    )
    assert response.status_code == 201, response.text
    return response.json()


async def test_attach_list_get_update_detach_round_trip(client: AsyncClient) -> None:
    project = await _create_project(client)
    file = await _upload_file(client, "paper.pdf")

    add_response = await client.post(
        f"/api/v1/projects/{project['id']}/sources",
        json={"fileId": file["id"], "authors": "Ada Lovelace", "year": "1843"},
    )
    assert add_response.status_code == 201, add_response.text
    source = add_response.json()
    assert source["fileId"] == file["id"]
    assert source["name"] == "paper.pdf"
    assert source["sizeBytes"] == file["sizeBytes"]
    assert source["type"] == "pdf"
    assert source["chunksCount"] is None
    assert source["status"] == "ready"
    assert source["uploadDate"] == file["createdAt"]
    assert source["authors"] == "Ada Lovelace"
    assert source["year"] == "1843"
    assert source["doi"] is None

    list_response = await client.get(f"/api/v1/projects/{project['id']}/sources")
    assert list_response.status_code == 200
    page = list_response.json()
    assert page["total"] == 1
    assert [item["id"] for item in page["items"]] == [source["id"]]

    get_response = await client.get(
        f"/api/v1/projects/{project['id']}/sources/{source['id']}"
    )
    assert get_response.status_code == 200
    assert get_response.json() == source

    project_response = await client.get(f"/api/v1/projects/{project['id']}")
    assert project_response.status_code == 200
    assert project_response.json()["sources"] == [source]

    summaries = await client.get("/api/v1/projects")
    assert summaries.json()["items"][0]["sourcesCount"] == 1

    update_response = await client.patch(
        f"/api/v1/projects/{project['id']}/sources/{source['id']}",
        json={"doi": "10.1/xyz"},
    )
    assert update_response.status_code == 200
    updated = update_response.json()
    assert updated["doi"] == "10.1/xyz"
    assert updated["authors"] == "Ada Lovelace"

    delete_response = await client.delete(
        f"/api/v1/projects/{project['id']}/sources/{source['id']}"
    )
    assert delete_response.status_code == 204

    empty_list = await client.get(f"/api/v1/projects/{project['id']}/sources")
    assert empty_list.json()["total"] == 0

    # Detaching a source does not delete the underlying file.
    file_get = await client.get(f"/api/v1/files/{file['id']}")
    assert file_get.status_code == 200


async def test_add_source_defaults_type_from_extension(client: AsyncClient) -> None:
    project = await _create_project(client)
    for filename, expected_type in [
        ("report.docx", "doc"),
        ("slides.pptx", "ppt"),
        ("notes.md", "md"),
        ("readme.txt", "txt"),
    ]:
        file = await _upload_file(client, filename)
        response = await client.post(
            f"/api/v1/projects/{project['id']}/sources", json={"fileId": file["id"]}
        )
        assert response.status_code == 201, response.text
        assert response.json()["type"] == expected_type


async def test_add_source_explicit_type_overrides_inference(client: AsyncClient) -> None:
    project = await _create_project(client)
    file = await _upload_file(client, "book.pdf")

    response = await client.post(
        f"/api/v1/projects/{project['id']}/sources",
        json={"fileId": file["id"], "type": "book"},
    )

    assert response.status_code == 201
    assert response.json()["type"] == "book"


async def test_add_source_unknown_project_returns_404(client: AsyncClient) -> None:
    file = await _upload_file(client, "notes.txt")

    response = await client.post(
        f"/api/v1/projects/{uuid.uuid4()}/sources", json={"fileId": file["id"]}
    )

    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"


async def test_add_source_unknown_file_returns_404(client: AsyncClient) -> None:
    project = await _create_project(client)

    response = await client.post(
        f"/api/v1/projects/{project['id']}/sources",
        json={"fileId": str(uuid.uuid4())},
    )

    assert response.status_code == 404


async def test_add_source_ineligible_file_returns_422(client: AsyncClient) -> None:
    project = await _create_project(client)
    file = await _upload_file(client, "refs.bib")
    assert file["kbEligible"] is False

    response = await client.post(
        f"/api/v1/projects/{project['id']}/sources", json={"fileId": file["id"]}
    )

    assert response.status_code == 422
    assert response.headers["content-type"] == "application/problem+json"


async def test_add_duplicate_file_in_same_project_returns_409(client: AsyncClient) -> None:
    project = await _create_project(client)
    file = await _upload_file(client, "book.pdf")

    first = await client.post(
        f"/api/v1/projects/{project['id']}/sources", json={"fileId": file["id"]}
    )
    assert first.status_code == 201

    second = await client.post(
        f"/api/v1/projects/{project['id']}/sources", json={"fileId": file["id"]}
    )
    assert second.status_code == 409
    assert second.headers["content-type"] == "application/problem+json"


async def test_same_file_can_be_attached_to_different_projects(client: AsyncClient) -> None:
    project_a = await _create_project(client, title="A")
    project_b = await _create_project(client, title="B")
    file = await _upload_file(client, "book.pdf")

    first = await client.post(
        f"/api/v1/projects/{project_a['id']}/sources", json={"fileId": file["id"]}
    )
    second = await client.post(
        f"/api/v1/projects/{project_b['id']}/sources", json={"fileId": file["id"]}
    )

    assert first.status_code == 201
    assert second.status_code == 201


async def test_delete_file_referenced_by_source_returns_409(client: AsyncClient) -> None:
    project = await _create_project(client)
    file = await _upload_file(client, "book.pdf")
    add_response = await client.post(
        f"/api/v1/projects/{project['id']}/sources", json={"fileId": file["id"]}
    )
    assert add_response.status_code == 201

    delete_response = await client.delete(f"/api/v1/files/{file['id']}")

    assert delete_response.status_code == 409
    assert delete_response.headers["content-type"] == "application/problem+json"


async def test_deleting_project_cascades_to_sources(client: AsyncClient) -> None:
    project = await _create_project(client)
    file = await _upload_file(client, "book.pdf")
    add_response = await client.post(
        f"/api/v1/projects/{project['id']}/sources", json={"fileId": file["id"]}
    )
    assert add_response.status_code == 201

    delete_response = await client.delete(f"/api/v1/projects/{project['id']}")
    assert delete_response.status_code == 204

    # The file itself survives the project delete, and is no longer
    # referenced once its owning source row was cascade-deleted.
    file_get = await client.get(f"/api/v1/files/{file['id']}")
    assert file_get.status_code == 200
    file_delete = await client.delete(f"/api/v1/files/{file['id']}")
    assert file_delete.status_code == 204


async def test_get_update_delete_missing_source_return_404(client: AsyncClient) -> None:
    project = await _create_project(client)
    missing_source_id = uuid.uuid4()

    get_response = await client.get(
        f"/api/v1/projects/{project['id']}/sources/{missing_source_id}"
    )
    patch_response = await client.patch(
        f"/api/v1/projects/{project['id']}/sources/{missing_source_id}",
        json={"year": "2020"},
    )
    delete_response = await client.delete(
        f"/api/v1/projects/{project['id']}/sources/{missing_source_id}"
    )

    assert get_response.status_code == 404
    assert patch_response.status_code == 404
    assert delete_response.status_code == 404


async def test_sources_endpoints_404_for_unknown_project(client: AsyncClient) -> None:
    missing_project_id = uuid.uuid4()

    response = await client.get(f"/api/v1/projects/{missing_project_id}/sources")

    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"


async def test_create_project_with_sources_attaches_them_atomically(
    client: AsyncClient,
) -> None:
    file = await _upload_file(client, "book.pdf")

    response = await client.post(
        "/api/v1/projects",
        json={**PROJECT_PAYLOAD, "sources": [{"fileId": file["id"], "authors": "Ada"}]},
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert len(body["sources"]) == 1
    assert body["sources"][0]["fileId"] == file["id"]
    assert body["sources"][0]["authors"] == "Ada"


async def test_create_project_with_invalid_source_rolls_back_project(
    client: AsyncClient,
) -> None:
    response = await client.post(
        "/api/v1/projects",
        json={**PROJECT_PAYLOAD, "sources": [{"fileId": str(uuid.uuid4())}]},
    )

    assert response.status_code == 404

    listing = await client.get("/api/v1/projects")
    assert listing.json()["total"] == 0


async def test_duplicate_project_copies_sources_pointing_at_same_files(
    client: AsyncClient,
) -> None:
    project = await _create_project(client)
    file = await _upload_file(client, "book.pdf")
    await client.post(
        f"/api/v1/projects/{project['id']}/sources",
        json={"fileId": file["id"], "authors": "Ada"},
    )

    response = await client.post(f"/api/v1/projects/{project['id']}/duplicate")

    assert response.status_code == 201
    body = response.json()
    assert len(body["sources"]) == 1
    duplicated_source = body["sources"][0]
    assert duplicated_source["fileId"] == file["id"]
    assert duplicated_source["authors"] == "Ada"

    original = await client.get(f"/api/v1/projects/{project['id']}")
    original_source = original.json()["sources"][0]
    assert duplicated_source["id"] != original_source["id"]
