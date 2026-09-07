from __future__ import annotations

import os
from contextlib import asynccontextmanager

import psycopg
from fastapi import FastAPI


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://autogenbook:autogenbook@db:5432/autogenbook",
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Keep the initial connection check out of import time so the API can start
    # while PostgreSQL is still becoming ready.
    yield


app = FastAPI(title="AutoGenBook API", version="0.1.0", lifespan=lifespan)


@app.get("/api/health", tags=["system"])
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/ready", tags=["system"])
def ready() -> dict[str, str]:
    with psycopg.connect(DATABASE_URL, connect_timeout=3) as connection:
        connection.execute("SELECT 1")
    return {"status": "ready"}
