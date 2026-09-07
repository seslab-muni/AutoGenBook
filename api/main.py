from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from fastapi.routing import APIRoute

from api.core.db import get_engine
from api.core.errors import install_error_handlers
from api.presentation.routers import files, outline, projects, runs, sources, system


@asynccontextmanager
async def lifespan(_: FastAPI):
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
            "mounted under /api/v1; there is no authentication and no CORS "
            "middleware. Error responses use RFC 9457 problem details "
            "(application/problem+json); list endpoints return a "
            "{items, total, limit, offset} page envelope."
        ),
        lifespan=lifespan,
    )
    install_error_handlers(app)

    api_router = APIRouter(prefix="/api/v1")
    api_router.include_router(system.router)
    api_router.include_router(files.router)
    api_router.include_router(projects.router)
    api_router.include_router(sources.router)
    api_router.include_router(outline.router)
    api_router.include_router(runs.router)
    app.include_router(api_router)

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
