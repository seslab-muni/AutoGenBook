"""Tests for `GET /api/v1/system/models` (issue #128): the model-discovery endpoint behind the
project-settings/start-run model pickers. `ModelCatalog` is stubbed via `get_model_catalog`'s
dependency override (the same pattern `get_file_storage` uses elsewhere) so these never make a
real network call.
"""

from __future__ import annotations

from httpx import AsyncClient

from api.domain.models import LlmModelInfo
from api.infrastructure.llm.model_catalog import CachingModelCatalog
from api.presentation.deps import get_model_catalog


class _StubCatalog:
    def __init__(self, items: list[LlmModelInfo] | None = None, error: Exception | None = None):
        self._items = items or []
        self._error = error
        self.calls = 0

    async def list_models(self) -> list[LlmModelInfo]:
        self.calls += 1
        if self._error is not None:
            raise self._error
        return self._items


async def test_list_models_returns_catalog_items(app, authed_client: AsyncClient) -> None:
    catalog = _StubCatalog(
        items=[
            LlmModelInfo(id="openai/gpt-5-mini", name="GPT-5 mini"),
            LlmModelInfo(id="anthropic/claude-3.5-sonnet"),
        ]
    )
    app.dependency_overrides[get_model_catalog] = lambda: catalog

    response = await authed_client.get("/api/v1/system/models")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["warning"] is None
    assert body["items"] == [
        {"id": "openai/gpt-5-mini", "name": "GPT-5 mini"},
        {"id": "anthropic/claude-3.5-sonnet", "name": None},
    ]


async def test_list_models_degrades_to_empty_list_with_warning_on_error(
    app, authed_client: AsyncClient
) -> None:
    app.dependency_overrides[get_model_catalog] = lambda: _StubCatalog(
        error=RuntimeError("endpoint unreachable")
    )

    response = await authed_client.get("/api/v1/system/models")

    # Never a 5xx (issue #128's acceptance criteria) - a network/HTTP/parse failure degrades to
    # an empty list plus a warning instead.
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["items"] == []
    assert body["warning"]


async def test_list_models_sanitizes_a_warning_that_looks_like_it_carries_a_url(
    app, authed_client: AsyncClient
) -> None:
    app.dependency_overrides[get_model_catalog] = lambda: _StubCatalog(
        error=RuntimeError("could not reach https://openrouter.ai/api/v1/models: timed out")
    )

    response = await authed_client.get("/api/v1/system/models")

    assert response.status_code == 200, response.text
    warning = response.json()["warning"]
    assert warning is not None
    assert "openrouter.ai" not in warning


async def test_list_models_requires_auth(client: AsyncClient) -> None:
    response = await client.get("/api/v1/system/models")
    assert response.status_code == 401


async def test_caching_model_catalog_serves_cached_result_within_ttl() -> None:
    now = [0.0]
    inner = _StubCatalog(items=[LlmModelInfo(id="openai/gpt-5-mini")])
    caching = CachingModelCatalog(inner, ttl_s=300.0, clock=lambda: now[0])

    first = await caching.list_models()
    now[0] = 100.0
    second = await caching.list_models()

    assert first == second
    assert inner.calls == 1


async def test_caching_model_catalog_refetches_after_ttl_expires() -> None:
    now = [0.0]
    inner = _StubCatalog(items=[LlmModelInfo(id="openai/gpt-5-mini")])
    caching = CachingModelCatalog(inner, ttl_s=300.0, clock=lambda: now[0])

    await caching.list_models()
    now[0] = 301.0
    await caching.list_models()

    assert inner.calls == 2


async def test_caching_model_catalog_never_caches_a_failure() -> None:
    inner = _StubCatalog(error=RuntimeError("boom"))
    caching = CachingModelCatalog(inner, ttl_s=300.0, clock=lambda: 0.0)

    for _ in range(3):
        try:
            await caching.list_models()
        except RuntimeError:
            pass

    # Every call actually re-hit the inner catalog - a failure is never cached, so the endpoint
    # (and the deployment it's calling) gets to recover without waiting out the TTL.
    assert inner.calls == 3
