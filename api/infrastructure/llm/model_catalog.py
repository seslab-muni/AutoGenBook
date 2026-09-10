"""Adapters behind `api.domain.ports.ModelCatalog` (issue #128): list the models the
configured OpenAI-compatible LLM endpoint offers, for `GET /api/v1/system/models`.

`httpx` is only a *dev* dependency of this API (`api/requirements-dev.txt`, pulled in for
`TestClient`/`AsyncClient`) - not a runtime one (`api/requirements.txt`) - so the real network
call here goes through the standard library's `urllib` instead of adding a new runtime
dependency for one endpoint.
"""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from time import monotonic
from typing import Callable

from starlette.concurrency import run_in_threadpool

from api.core.settings import Settings, resolved_llm_api_key, resolved_llm_base_url
from api.domain.models import LlmModelInfo
from api.domain.ports import ModelCatalog

# Generous but bounded: this endpoint is user-facing (a dialog opening), not a background job -
# a slow/unreachable third-party endpoint shouldn't hang the request indefinitely.
_DEFAULT_TIMEOUT_S = 10.0

# ~5 minutes: long enough that opening the project-settings/start-run dialog repeatedly doesn't
# re-hit the network every time, short enough that a newly-added model on the endpoint shows up
# without restarting the API.
_DEFAULT_CACHE_TTL_S = 300.0


class ModelCatalogError(Exception):
    """Raised by `UrllibModelCatalog.list_models` on any network/HTTP/parse failure -
    `SystemService.list_models` is the only place that catches it."""


class UrllibModelCatalog:
    """`ModelCatalog` backed by a real `GET {base_url}/models` call - the OpenAI-compatible
    shape every provider this CLI targets (OpenRouter, LM Studio, ...) implements."""

    def __init__(self, settings: Settings, *, timeout_s: float = _DEFAULT_TIMEOUT_S) -> None:
        self._settings = settings
        self._timeout_s = timeout_s

    async def list_models(self) -> list[LlmModelInfo]:
        base_url = resolved_llm_base_url(self._settings)
        api_key = resolved_llm_api_key(self._settings)
        url = base_url.rstrip("/") + "/models"
        # A blocking `urlopen` call, kept off the event loop the same way every other
        # synchronous I/O in this codebase is (e.g. `GenerationService`'s filesystem writes).
        return await run_in_threadpool(self._fetch_sync, url, api_key)

    def _fetch_sync(self, url: str, api_key: str | None) -> list[LlmModelInfo]:
        headers = {"Accept": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self._timeout_s) as response:
                raw = response.read()
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            # `urllib.error.HTTPError` (a non-2xx status) is a `URLError` subclass, so a 401/404/
            # 5xx from the endpoint is caught here too, not just connection-level failures.
            raise ModelCatalogError(f"could not reach {url}: {exc}") from exc
        try:
            payload = json.loads(raw)
        except (ValueError, UnicodeDecodeError) as exc:
            raise ModelCatalogError(f"invalid JSON from {url}: {exc}") from exc
        entries = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(entries, list):
            raise ModelCatalogError(f"unexpected response shape from {url}: no 'data' array")
        models: list[LlmModelInfo] = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            model_id = entry.get("id")
            if not isinstance(model_id, str) or not model_id.strip():
                continue
            name = entry.get("name")
            models.append(LlmModelInfo(id=model_id, name=name if isinstance(name, str) else None))
        return models


class CachingModelCatalog:
    """Wraps another `ModelCatalog` with an in-process cache of its last *successful* result
    (issue #128: "cache the result ... for ~5 minutes"). A failure is never cached - it's cheap
    to retry on the next call, and caching an empty/error result would keep serving "endpoint
    unreachable" for the full TTL even after the endpoint recovers.

    Instantiated once as a singleton (`api.presentation.deps.get_model_catalog`, `@lru_cache`,
    the same pattern `get_file_storage` already uses) so every request shares one cache instead
    of each getting its own via a fresh dependency."""

    def __init__(
        self,
        inner: ModelCatalog,
        *,
        ttl_s: float = _DEFAULT_CACHE_TTL_S,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        self._inner = inner
        self._ttl_s = ttl_s
        self._clock = clock
        self._cached: list[LlmModelInfo] | None = None
        self._cached_at: float = float("-inf")
        # Issue #128 review, fix 10: without this, N requests landing concurrently on a cold (or
        # just-expired) cache each fell through to `self._inner.list_models()` on their own - N
        # upstream `GET /models` calls instead of one, all racing to fill the same cache. Every
        # `list_models` awaits the same lock, so only the first caller through it actually
        # refreshes; everyone else re-checks the (now-fresh) cache once they get the lock rather
        # than firing a redundant request of their own.
        self._lock = asyncio.Lock()

    async def list_models(self) -> list[LlmModelInfo]:
        if (models := self._fresh_cached()) is not None:
            return models
        async with self._lock:
            # Another concurrent caller may have already refreshed the cache while this one
            # waited for the lock - re-check before hitting the inner catalog again.
            if (models := self._fresh_cached()) is not None:
                return models
            items = await self._inner.list_models()
            self._cached = items
            self._cached_at = self._clock()
            return items

    def _fresh_cached(self) -> list[LlmModelInfo] | None:
        if self._cached is not None and (self._clock() - self._cached_at) < self._ttl_s:
            return self._cached
        return None
