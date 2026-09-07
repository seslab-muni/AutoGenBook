from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

PROBLEM_JSON = "application/problem+json"


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
            jsonable_encoder(exc.errors()),
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
