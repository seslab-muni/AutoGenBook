from __future__ import annotations

import pytest
from httpx import AsyncClient

from api.core.db import get_session
from api.main import create_app


async def test_health_v1(client: AsyncClient) -> None:
    response = await client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_ready_v1_when_db_reachable(client: AsyncClient) -> None:
    response = await client.get("/api/v1/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ready"}


async def test_legacy_health_and_ready_aliases_still_work(client: AsyncClient) -> None:
    assert (await client.get("/api/health")).status_code == 200
    assert (await client.get("/api/ready")).status_code == 200


async def test_legacy_aliases_excluded_from_openapi(client: AsyncClient) -> None:
    schema = (await client.get("/openapi.json")).json()
    assert "/api/health" not in schema["paths"]
    assert "/api/ready" not in schema["paths"]
    assert "/api/v1/health" in schema["paths"]


@pytest.fixture
async def broken_db_client():
    application = create_app()

    async def override_get_session():
        class _BrokenSession:
            async def execute(self, *_args, **_kwargs):
                raise RuntimeError("connection refused")

        yield _BrokenSession()

    application.dependency_overrides[get_session] = override_get_session

    from httpx import ASGITransport

    transport = ASGITransport(app=application)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac


async def test_ready_v1_returns_503_problem_json_when_db_unreachable(
    broken_db_client: AsyncClient,
) -> None:
    response = await broken_db_client.get("/api/v1/ready")
    assert response.status_code == 503
    assert response.headers["content-type"] == "application/problem+json"
    body = response.json()
    assert body["status"] == 503
    assert body["title"] == "Service Unavailable"
    assert body["instance"] == "/api/v1/ready"
