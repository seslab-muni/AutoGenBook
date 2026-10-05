from __future__ import annotations

import json
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

PROBLEM_JSON = "application/problem+json"

# `RequestValidationError.errors()` echoes back the offending `input` value
# verbatim, unbounded - a client that (accidentally or otherwise) posts a
# multi-MB body with one invalid field gets that whole body echoed straight
# back in the 422 response (issue #82). Capped to a small prefix, just
# enough to help a caller spot what they sent wrong.
_MAX_ECHOED_INPUT_LEN = 200


def _cap_echoed_input(value: Any) -> Any:
    if isinstance(value, str) and len(value) > _MAX_ECHOED_INPUT_LEN:
        return value[:_MAX_ECHOED_INPUT_LEN] + "...(truncated)"
    encoded = jsonable_encoder(value)
    if isinstance(encoded, (dict, list)) and len(json.dumps(encoded)) > _MAX_ECHOED_INPUT_LEN:
        return "(input omitted: too large)"
    return value


# Routes whose request body carries a secret: their 422 bodies must never echo `input` (nor
# `ctx`), whatever field the client got wrong - e.g. a wrong field name makes pydantic report
# the whole secret value as the offending input of an `extra_forbidden` error.
# Any new route whose request body carries a secret (password, API key, token, ...) MUST be
# registered here, or a wrong field name will echo the secret back in its 422.
_SECRET_BODY_PATH_SUFFIXES = ("/auth/me/llm-key", "/auth/login")


def _strip_inputs(errors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{k: v for k, v in error.items() if k not in ("input", "ctx")} for error in errors]


def _cap_validation_errors(errors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    capped = []
    for error in errors:
        if "input" in error:
            error = {**error, "input": _cap_echoed_input(error["input"])}
        capped.append(error)
    return capped


class ApiError(Exception):
    """Base of the domain exception hierarchy; maps to an RFC 9457 problem body."""

    status_code: int = status.HTTP_500_INTERNAL_SERVER_ERROR
    title: str = "Internal Server Error"
    # Extra response headers `_problem_response` sets alongside the problem
    # body - only `Unauthorized` uses this (`WWW-Authenticate: Cookie`).
    headers: dict[str, str] | None = None

    def __init__(self, detail: str | None = None, *, code: str | None = None) -> None:
        self.detail = detail
        # Optional machine-readable discriminator (e.g. `llm_key_required`), emitted as
        # the problem body's `code` extension member so a client can branch on it
        # instead of string-matching `detail`.
        self.code = code
        super().__init__(detail)


class NotFound(ApiError):
    status_code = status.HTTP_404_NOT_FOUND
    title = "Not Found"


class Unauthorized(ApiError):
    status_code = status.HTTP_401_UNAUTHORIZED
    title = "Unauthorized"
    headers = {"WWW-Authenticate": "Cookie"}


class Forbidden(ApiError):
    status_code = status.HTTP_403_FORBIDDEN
    title = "Forbidden"


class Conflict(ApiError):
    status_code = status.HTTP_409_CONFLICT
    title = "Conflict"


class ValidationFailed(ApiError):
    status_code = 422
    title = "Validation Failed"


class StorageError(ApiError):
    """A dependency the API relies on (DB, object storage) is unreachable."""

    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    title = "Service Unavailable"


class PayloadTooLarge(ApiError):
    status_code = 413
    title = "Payload Too Large"


def _problem_response(
    status_code: int,
    title: str,
    detail: Any,
    instance: str,
    headers: dict[str, str] | None = None,
    code: str | None = None,
) -> JSONResponse:
    body: dict[str, Any] = {
        "type": "about:blank",
        "title": title,
        "status": status_code,
        "instance": instance,
    }
    if detail is not None:
        body["detail"] = detail
    if code is not None:
        body["code"] = code
    return JSONResponse(
        status_code=status_code, content=body, media_type=PROBLEM_JSON, headers=headers
    )


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def handle_api_error(request: Request, exc: ApiError) -> JSONResponse:
        return _problem_response(
            exc.status_code, exc.title, exc.detail, request.url.path, exc.headers, exc.code
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        errors = (
            _strip_inputs(exc.errors())
            if request.url.path.endswith(_SECRET_BODY_PATH_SUFFIXES)
            else _cap_validation_errors(exc.errors())
        )
        return _problem_response(
            422,
            "Validation Failed",
            jsonable_encoder(errors),
            request.url.path,
        )

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        return _problem_response(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Internal Server Error",
            None,
            request.url.path,
        )
