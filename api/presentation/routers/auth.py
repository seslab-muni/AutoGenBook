from __future__ import annotations

from fastapi import APIRouter, Depends, Response
from starlette import status

from api.application.auth import AuthService
from api.core.settings import Settings, get_settings
from api.domain.models import User
from api.presentation.deps import current_user, get_auth_service
from api.presentation.schemas.auth import LoginRequest, UserOut, user_to_schema

# Split in two so `api/main.py` can mount `public_router` (just `login`)
# dependency-free while everything else in this module goes on the guarded
# `/api/v1` router alongside every other route - see issue #96's "public
# routes" decision and the router-split rationale in `main.py`.
public_router = APIRouter(prefix="/auth", tags=["auth"])
router = APIRouter(prefix="/auth", tags=["auth"])


def _set_session_cookie(response: Response, token: str, settings: Settings) -> None:
    response.set_cookie(
        key=settings.auth_cookie_name,
        value=token,
        max_age=int(settings.auth_token_ttl_h * 3600),
        # `/api`, not `/`: the cookie is only ever read by this API (never
        # by frontend JS - it's httpOnly), and scoping it to the path nginx
        # actually proxies to the API keeps it out of any unrelated
        # same-origin request.
        path="/api",
        httponly=True,
        secure=settings.auth_cookie_secure,
        samesite="lax",
    )


async def login(
    body: LoginRequest,
    response: Response,
    settings: Settings = Depends(get_settings),
    auth_service: AuthService = Depends(get_auth_service),
) -> UserOut:
    user = await auth_service.authenticate(body.email, body.password)
    token = auth_service.issue_token(user)
    _set_session_cookie(response, token, settings)
    return user_to_schema(user)


# Registered on `public_router` only (not `router`) - it must stay reachable
# with no session cookie at all, so it can never sit behind the guarded
# `/api/v1` router's `current_user` dependency. See the module docstring.
public_router.add_api_route(
    "/login",
    login,
    methods=["POST"],
    response_model=UserOut,
    tags=["auth"],
    name="login",
)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    response: Response, settings: Settings = Depends(get_settings)
) -> Response:
    # Mutate (and return) the `Response` FastAPI injects, rather than
    # building a fresh one - a handler that returns its own `Response`
    # instance replaces the injected one entirely, silently dropping any
    # headers (the `Set-Cookie` from `delete_cookie` included) set on it.
    response.delete_cookie(key=settings.auth_cookie_name, path="/api")
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(current_user)) -> UserOut:
    return user_to_schema(user)
