from __future__ import annotations

from functools import lru_cache

from fastapi import Depends, Request, Security
from fastapi.security import APIKeyCookie
from sqlalchemy.ext.asyncio import AsyncSession

from api.application.auth import AuthService
from api.application.files import FileService
from api.application.outline import OutlineService
from api.application.runs import RunService
from api.core.db import get_session
from api.core.errors import Forbidden, Unauthorized
from api.core.settings import Settings, get_settings
from api.domain.models import User
from api.domain.ports import FileStorage
from api.infrastructure.db.file_repository import SqlAlchemyFileRepository
from api.infrastructure.db.outline_repository import SqlAlchemyOutlineRepository
from api.infrastructure.db.repositories import SqlAlchemyProjectRepository
from api.infrastructure.db.run_artifact_repository import SqlAlchemyRunArtifactRepository
from api.infrastructure.db.run_repository import (
    SqlAlchemyRunEventRepository,
    SqlAlchemyRunRepository,
)
from api.infrastructure.db.user_repository import SqlAlchemyUserRepository
from api.infrastructure.storage.s3 import S3FileStorage

# Requests with one of these methods carry no state-changing intent, so the
# CSRF header check below never applies to them (issue #96).
_CSRF_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
_CSRF_HEADER_NAME = "x-requested-with"
_CSRF_HEADER_VALUE = "XMLHttpRequest"


def get_auth_service(
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> AuthService:
    return AuthService(SqlAlchemyUserRepository(session), settings)


# A real `fastapi.security` scheme (not a plain function dependency) so
# FastAPI's OpenAPI generator records `securitySchemes.cookieAuth` and marks
# every operation that depends on `current_user` as requiring it (issue
# #96's API contract). The cookie name is read from settings once at import
# time - it's effectively fixed per deployment (an env var set before the
# process starts), the same assumption `Settings()` itself already makes.
_cookie_scheme = APIKeyCookie(
    name=get_settings().auth_cookie_name, scheme_name="cookieAuth", auto_error=False
)


async def current_user(
    token: str | None = Security(_cookie_scheme),
    auth_service: AuthService = Depends(get_auth_service),
) -> User:
    if not token:
        raise Unauthorized("authentication required")
    return await auth_service.verify_token(token)


async def require_csrf_header(request: Request) -> None:
    """Every non-GET/HEAD/OPTIONS `/api/v1` request must carry
    `X-Requested-With: XMLHttpRequest` (issue #96). A custom header can't be
    sent cross-origin without triggering a CORS preflight, and this API has
    no CORS middleware - so a foreign `<form>` POST relying on the ambient
    session cookie can never carry it, closing the CSRF hole `SameSite=Lax`
    alone leaves open for a plain top-level GET/POST navigation."""
    if request.method in _CSRF_SAFE_METHODS:
        return
    if request.headers.get(_CSRF_HEADER_NAME) != _CSRF_HEADER_VALUE:
        raise Forbidden("missing X-Requested-With header")


@lru_cache
def get_file_storage() -> FileStorage:
    return S3FileStorage(get_settings())


def get_file_service(
    session: AsyncSession = Depends(get_session),
    storage: FileStorage = Depends(get_file_storage),
    settings: Settings = Depends(get_settings),
) -> FileService:
    repository = SqlAlchemyFileRepository(session)
    return FileService(repository=repository, storage=storage, settings=settings)


def get_outline_service(session: AsyncSession = Depends(get_session)) -> OutlineService:
    return OutlineService(
        outline_repository=SqlAlchemyOutlineRepository(session),
        project_repository=SqlAlchemyProjectRepository(session),
        run_repository=SqlAlchemyRunRepository(session),
    )


def get_run_service(
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> RunService:
    return RunService(
        run_repository=SqlAlchemyRunRepository(session),
        run_event_repository=SqlAlchemyRunEventRepository(session),
        project_repository=SqlAlchemyProjectRepository(session),
        run_artifact_repository=SqlAlchemyRunArtifactRepository(session),
        file_repository=SqlAlchemyFileRepository(session),
        outline_repository=SqlAlchemyOutlineRepository(session),
        settings=settings,
    )
