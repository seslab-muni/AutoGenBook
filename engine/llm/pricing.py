"""Cost estimation without hardcoded rates.

Order: the provider-reported cost in the response (`usage.cost`, OpenRouter);
otherwise OpenRouter's list price from its `/models` endpoint, fetched once
per run and cached on disk as the fallback for the next run, but only when the
base URL *is* OpenRouter; otherwise `None` (unknown), never a made-up number.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any

import httpx

from engine.util.fs import atomic_write_json


class Pricing:
    def __init__(
        self,
        *,
        base_url: str,
        enabled: bool,
        http: httpx.AsyncClient | None,
        api_key: str | None,
        cache_path: Path | None,
        timeout_s: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.enabled = enabled
        self._http = http
        self._api_key = api_key
        self._cache_path = cache_path
        self._timeout = timeout_s
        self._table: dict[str, tuple[float, float]] | None = None
        self._lock = asyncio.Lock()

    async def _load(self) -> dict[str, tuple[float, float]]:
        if self._table is not None:
            return self._table
        async with self._lock:
            if self._table is not None:
                return self._table
            table: dict[str, tuple[float, float]] = {}
            data: Any = None
            if self._http is not None:
                try:
                    headers = {"Authorization": f"Bearer {self._api_key}"} if self._api_key else {}
                    resp = await self._http.get(f"{self.base_url}/models", headers=headers, timeout=self._timeout)
                    if resp.status_code == 200:
                        data = resp.json()
                        if self._cache_path is not None:
                            try:
                                atomic_write_json(self._cache_path, {"fetched_at": time.time(), "data": data.get("data", [])})
                            except OSError:
                                pass
                except (httpx.HTTPError, ValueError):
                    data = None
            if data is None and self._cache_path is not None and self._cache_path.exists():
                try:
                    data = json.loads(self._cache_path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    data = None
            for model in (data or {}).get("data", []) or []:
                pricing = model.get("pricing") or {}
                try:
                    table[str(model.get("id"))] = (float(pricing.get("prompt") or 0.0), float(pricing.get("completion") or 0.0))
                except (TypeError, ValueError):
                    continue
            self._table = table
            return table

    async def cost(self, model: str, prompt_tokens: int, completion_tokens: int, provider_cost: Any) -> tuple[float | None, str | None]:
        if isinstance(provider_cost, (int, float)):
            return float(provider_cost), "provider"
        if not self.enabled:
            return None, None
        table = await self._load()
        price = table.get(model)
        if price is None:
            return None, None
        return prompt_tokens * price[0] + completion_tokens * price[1], "openrouter_list_price"
