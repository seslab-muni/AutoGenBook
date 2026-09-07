from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI

from api.core.db import get_engine
from api.core.errors import install_error_handlers
from api.presentation.routers import system


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await get_engine().dispose()


def create_app() -> FastAPI:
    app = FastAPI(title="AutoGenBook API", version="0.1.0", lifespan=lifespan)
    install_error_handlers(app)

    api_router = APIRouter(prefix="/api/v1")
    api_router.include_router(system.router)
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
