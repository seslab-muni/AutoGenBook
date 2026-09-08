from __future__ import annotations

import contextvars
import logging
import time
import uuid
from collections.abc import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

REQUEST_ID_HEADER = "X-Request-Id"

# Readable by any logger via `RequestIdLogFilter` below, regardless of how
# deep in the call stack the log call happens - contextvars propagate across
# `await` within one request's task without needing to thread a request id
# through every function signature.
_request_id_ctx: contextvars.ContextVar[str] = contextvars.ContextVar(
    "request_id", default="-"
)

logger = logging.getLogger("api.request")


class RequestIdLogFilter(logging.Filter):
    """Stamps every log record with the current request's id (or `-`
    outside a request), for a format string containing `%(request_id)s`.

    Attach to a `Handler`, not a `Logger`: a `Logger`'s own filters only run
    for records it originates, not ones propagated up from a child logger
    (e.g. uvicorn's), so attaching this to the root handler is what makes it
    apply to every log line - see `configure_request_logging` below.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = _request_id_ctx.get()
        return True


def configure_request_logging(level: int = logging.INFO) -> None:
    """Minimal structured request logging (issue #83): give every log line
    a request id so a client-reported problem can be correlated with
    server-side logs. `basicConfig` is a no-op if the root logger already
    has handlers, so calling this more than once (e.g. once per worker
    process/test run) is safe.
    """
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s [request_id=%(request_id)s]: %(message)s",
    )
    request_id_filter = RequestIdLogFilter()
    for handler in logging.getLogger().handlers:
        if not any(isinstance(f, RequestIdLogFilter) for f in handler.filters):
            handler.addFilter(request_id_filter)


class RequestIdMiddleware(BaseHTTPMiddleware):
    """Assigns each request a request id - the client's own `X-Request-Id`
    header if it sent one, otherwise a fresh UUID4 - logs one line per
    request tagged with it, and echoes it back in the response header so a
    caller can correlate its request with server-side logs. Deliberately
    just this: not a full observability stack, just closing the "no request
    logging on the API" gap (issue #83).
    """

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request_id = request.headers.get(REQUEST_ID_HEADER) or str(uuid.uuid4())
        token = _request_id_ctx.set(request_id)
        start = time.monotonic()
        try:
            try:
                response = await call_next(request)
            except Exception:
                duration_ms = (time.monotonic() - start) * 1000
                logger.exception(
                    "%s %s failed after %.1fms", request.method, request.url.path, duration_ms
                )
                raise
            duration_ms = (time.monotonic() - start) * 1000
            logger.info(
                "%s %s -> %s in %.1fms",
                request.method,
                request.url.path,
                response.status_code,
                duration_ms,
            )
            response.headers[REQUEST_ID_HEADER] = request_id
            return response
        finally:
            _request_id_ctx.reset(token)
