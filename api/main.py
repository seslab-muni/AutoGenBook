from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import APIRouter, Depends, FastAPI
from fastapi.routing import APIRoute

from api.core.db import get_engine
from api.core.errors import install_error_handlers
from api.core.request_logging import RequestIdMiddleware, configure_request_logging
from api.core.settings import default_credentials_warning, get_settings
from api.presentation.deps import current_user, require_csrf_header
from api.presentation.routers import auth, files, outline, projects, runs, sources, system

configure_request_logging()
logger = logging.getLogger("api")


@asynccontextmanager
async def lifespan(_: FastAPI):
    warning = default_credentials_warning(get_settings())
    if warning:
        logger.warning(warning)
    yield
    await get_engine().dispose()


def _generate_unique_operation_id(route: APIRoute) -> str:
    """Stable, readable operationIds (`<tag>-<function_name>`) instead of
    FastAPI's default `<function_name>_<full_path>_<method>`, so generated
    clients (e.g. openapi-typescript) get short, stable method names."""
    tag = route.tags[0] if route.tags else "default"
    return f"{tag}-{route.name}"


def create_app() -> FastAPI:
    app = FastAPI(
        title="AutoGenBook API",
        version="0.1.0",
        generate_unique_id_function=_generate_unique_operation_id,
        description=(
            "HTTP API for AutoGenBook, served by this FastAPI app and reached "
            "through the nginx-fronted Docker Compose stack. Every route is "
            "mounted under /api/v1 and requires a session cookie (set by "
            "POST /api/v1/auth/login) except that route itself and the "
            "health/ready probes; there is no CORS middleware. Non-GET/HEAD/"
            "OPTIONS requests additionally require an "
            "'X-Requested-With: XMLHttpRequest' header or are rejected with "
            "403. Error responses use RFC 9457 problem details "
            "(application/problem+json); list endpoints return a "
            "{items, total, limit, offset} page envelope."
        ),
        lifespan=lifespan,
    )
    install_error_handlers(app)
    app.add_middleware(RequestIdMiddleware)

    # An explicit "public" router (login, health, ready) beats a path
    # allowlist on the guarded one: a new route added to any of the routers
    # below is guarded by default, not accidentally public by omission
    # (issue #96's acceptance criteria - enforced for real by the
    # route-walk test in tests/api/test_auth.py). Still carries
    # `require_csrf_header` (unlike `current_user`): the CSRF rule is stated
    # unconditionally over all of `/api/v1`, and costs nothing here since
    # GET /health and GET /ready are safe methods it already no-ops for.
    public_router = APIRouter(
        prefix="/api/v1", dependencies=[Depends(require_csrf_header)]
    )
    public_router.include_router(auth.public_router)
    public_router.include_router(system.router)

    guarded_router = APIRouter(
        prefix="/api/v1",
        dependencies=[Depends(current_user), Depends(require_csrf_header)],
    )
    guarded_router.include_router(auth.router)
    guarded_router.include_router(files.router)
    guarded_router.include_router(projects.router)
    guarded_router.include_router(sources.router)
    guarded_router.include_router(outline.router)
    guarded_router.include_router(runs.router)

    app.include_router(public_router)
    app.include_router(guarded_router)

    # Legacy aliases kept until the compose healthcheck (issue 02) moves to
    # /api/v1/ready; excluded from the OpenAPI schema so they don't leak as
    # a second documented surface.
    app.add_api_route(
        "/api/health", system.health, methods=["GET"], include_in_schema=False
    )
    app.add_api_route(
        "/api/ready", system.ready, methods=["GET"], include_in_schema=False
    )

    return app


app = create_app()
