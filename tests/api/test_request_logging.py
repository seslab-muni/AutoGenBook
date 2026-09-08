"""Tests for the request-id middleware (issue #83): every response should
carry an `X-Request-Id` header, either echoing back a client-supplied one or
a freshly generated one.
"""

from __future__ import annotations

import uuid

from httpx import AsyncClient

from api.core.request_logging import REQUEST_ID_HEADER


async def test_response_echoes_generated_request_id_when_none_supplied(
    client: AsyncClient,
) -> None:
    response = await client.get("/api/v1/health")
    assert response.status_code == 200
    request_id = response.headers.get(REQUEST_ID_HEADER)
    assert request_id
    # Must be a valid UUID4 when the client didn't supply one.
    assert uuid.UUID(request_id).version == 4


async def test_response_echoes_client_supplied_request_id(client: AsyncClient) -> None:
    response = await client.get(
        "/api/v1/health", headers={REQUEST_ID_HEADER: "my-custom-id-123"}
    )
    assert response.status_code == 200
    assert response.headers.get(REQUEST_ID_HEADER) == "my-custom-id-123"


async def test_distinct_requests_get_distinct_generated_ids(client: AsyncClient) -> None:
    first = await client.get("/api/v1/health")
    second = await client.get("/api/v1/health")
    assert first.headers[REQUEST_ID_HEADER] != second.headers[REQUEST_ID_HEADER]
