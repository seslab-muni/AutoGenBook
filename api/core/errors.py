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

    def __init__(self, detail: str | None = None) -> None:
        self.detail = detail
        super().__init__(detail)


class NotFound(ApiError):
    status_code = status.HTTP_404_NOT_FOUND
    title = "Not Found"


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
    status_code: int, title: str, detail: Any, instance: str
) -> JSONResponse:
    body: dict[str, Any] = {
        "type": "about:blank",
        "title": title,
        "status": status_code,
        "instance": instance,
    }
    if detail is not None:
        body["detail"] = detail
    return JSONResponse(status_code=status_code, content=body, media_type=PROBLEM_JSON)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def handle_api_error(request: Request, exc: ApiError) -> JSONResponse:
        return _problem_response(exc.status_code, exc.title, exc.detail, request.url.path)

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return _problem_response(
            422,
            "Validation Failed",
            jsonable_encoder(_cap_validation_errors(exc.errors())),
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
