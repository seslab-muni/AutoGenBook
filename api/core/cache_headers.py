"""`Cache-Control: no-store` on every API response that doesn't set its own.

API responses are per-user, per-moment JSON; there is nothing in them a
browser should ever reuse without asking. Without an explicit header the
browser decides on its own what to keep: a successful response that
arrived with a `Last-Modified` or via a cached redirect can be answered
from the HTTP cache for hours, and after a deploy that surfaced as a page
that kept receiving a stale non-JSON body for an API URL until the user
hard-reloaded (the frontend sends `cache: 'no-store'` too, see
`app/src/api/client.ts`; this is the server-side half, so any client gets
the right answer). `setdefault` keeps a route's own, more specific policy
(none set one today; `GET /files/{id}/content` sends an `ETag` and may
want to allow revalidation later).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

CACHE_CONTROL_HEADER = "Cache-Control"
NO_STORE = "no-store"


class NoStoreMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        response = await call_next(request)
        if CACHE_CONTROL_HEADER not in response.headers:
            response.headers[CACHE_CONTROL_HEADER] = NO_STORE
        return response
