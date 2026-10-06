"""Every API response carries `Cache-Control: no-store` unless the route set
its own policy (`api/core/cache_headers.py`): a browser must never answer an
API request from its HTTP cache, which is how a stale page kept seeing a
cached non-JSON body for an API URL after a deploy until a hard reload.
"""

from __future__ import annotations

from httpx import AsyncClient

from api.core.cache_headers import CACHE_CONTROL_HEADER, NO_STORE


async def test_success_response_is_no_store(client: AsyncClient) -> None:
    response = await client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.headers.get(CACHE_CONTROL_HEADER) == NO_STORE


async def test_error_response_is_no_store(client: AsyncClient) -> None:
    # An unauthenticated request to a guarded route: the problem-details 401
    # must not be cacheable either, or a browser could keep answering the
    # URL with it after the user has logged in.
    response = await client.get("/api/v1/projects")
    assert response.status_code == 401
    assert response.headers.get(CACHE_CONTROL_HEADER) == NO_STORE


async def test_not_found_response_is_no_store(client: AsyncClient) -> None:
    response = await client.get("/api/v1/does-not-exist")
    assert response.status_code == 404
    assert response.headers.get(CACHE_CONTROL_HEADER) == NO_STORE
