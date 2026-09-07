from __future__ import annotations

from collections.abc import AsyncIterator

import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import BaseModel

from api.core.errors import Conflict, NotFound, ValidationFailed, install_error_handlers


class _Item(BaseModel):
    name: str


def _build_error_test_app() -> FastAPI:
    app = FastAPI()
    install_error_handlers(app)

    @app.get("/not-found")
    async def raise_not_found():
        raise NotFound("widget 42 does not exist")

    @app.get("/conflict")
    async def raise_conflict():
        raise Conflict("widget 42 already exists")

    @app.get("/validation-failed")
    async def raise_validation_failed():
        raise ValidationFailed("widget name is required")

    @app.get("/boom")
    async def raise_unexpected():
        raise RuntimeError("kaboom")

    @app.post("/items")
    async def create_item(item: _Item):
        return item

    return app


@pytest_asyncio.fixture
async def error_client() -> AsyncIterator[AsyncClient]:
    # Starlette's ServerErrorMiddleware re-raises after building the 500 response
    # (so a real ASGI server can log it); tell the test transport not to
    # propagate that re-raise, since we only care about the response it built.
    transport = ASGITransport(app=_build_error_test_app(), raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac


async def test_not_found_returns_404_problem_json(error_client: AsyncClient) -> None:
    response = await error_client.get("/not-found")
    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"
    body = response.json()
    assert body == {
        "type": "about:blank",
        "title": "Not Found",
        "status": 404,
        "instance": "/not-found",
        "detail": "widget 42 does not exist",
    }


async def test_conflict_returns_409_problem_json(error_client: AsyncClient) -> None:
    response = await error_client.get("/conflict")
    assert response.status_code == 409
    assert response.json()["title"] == "Conflict"


async def test_validation_failed_domain_error_returns_422_problem_json(
    error_client: AsyncClient,
) -> None:
    response = await error_client.get("/validation-failed")
    assert response.status_code == 422
    assert response.json()["title"] == "Validation Failed"


async def test_request_validation_error_returns_422_problem_json(
    error_client: AsyncClient,
) -> None:
    response = await error_client.post("/items", json={})
    assert response.status_code == 422
    assert response.headers["content-type"] == "application/problem+json"
    body = response.json()
    assert body["title"] == "Validation Failed"
    assert isinstance(body["detail"], list)


async def test_unhandled_exception_returns_500_problem_json_without_stack_trace(
    error_client: AsyncClient,
) -> None:
    response = await error_client.get("/boom")
    assert response.status_code == 500
    assert response.headers["content-type"] == "application/problem+json"
    body = response.json()
    assert body["title"] == "Internal Server Error"
    assert "detail" not in body
    assert "kaboom" not in response.text
