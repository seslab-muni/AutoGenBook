"""Transient-error classification and backoff (jittered, honouring Retry-After)."""

from __future__ import annotations

import email.utils
import random
import time
from typing import Any

import httpx

# 408 request timeout, 409/425 transient conflicts some gateways use, 429 rate
# limit, 5xx server/gateway errors (including Cloudflare's 52x).
TRANSIENT_STATUS = {408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529}
THROTTLE_STATUS = {429, 503}
MAX_RETRY_AFTER_S = 120.0


def status_of(exc: BaseException) -> int | None:
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return status
    response = getattr(exc, "response", None)
    if isinstance(response, httpx.Response):
        return response.status_code
    return None


def is_transient(exc: BaseException) -> bool:
    import openai

    if isinstance(exc, (openai.APITimeoutError, openai.APIConnectionError)):
        return True
    if isinstance(exc, (httpx.TimeoutException, httpx.TransportError)):
        return True
    status = status_of(exc)
    return status in TRANSIENT_STATUS if status is not None else False


def retry_after_seconds(exc: BaseException | None = None, response: Any = None) -> float | None:
    """`Retry-After` (seconds or HTTP date) or `retry-after-ms`, capped."""
    if response is None and exc is not None:
        response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if not headers:
        return None
    ms = headers.get("retry-after-ms")
    if ms:
        try:
            return min(MAX_RETRY_AFTER_S, max(0.0, float(ms) / 1000.0))
        except ValueError:
            pass
    value = headers.get("retry-after")
    if not value:
        return None
    try:
        return min(MAX_RETRY_AFTER_S, max(0.0, float(value)))
    except ValueError:
        pass
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    return min(MAX_RETRY_AFTER_S, max(0.0, when.timestamp() - time.time()))


def backoff_seconds(attempt: int, *, base: float = 1.0, cap: float = 60.0, retry_after: float | None = None, rng: random.Random | None = None) -> float:
    """Exponential backoff with equal jitter; `Retry-After` wins when given
    (plus up to 10 % jitter so simultaneous waiters do not return together)."""
    rng = rng or random
    if retry_after is not None:
        return retry_after * (1.0 + 0.1 * rng.random())
    delay = min(cap, base * (2 ** attempt))
    return delay / 2 + rng.random() * delay / 2
