# Web API Reference (HTTP/REST)

This document describes the HTTP API exposed by the FastAPI service in `api/` (`api/main.py:create_app`), reached through the nginx-fronted Docker Compose stack at `/api/...` (`docker-compose.yml`, `app/nginx.conf`). A machine-readable companion spec lives at `openapi.yaml` in this same directory.

This is a different document from [`API_REFERENCE.md`](API_REFERENCE.md), which covers the Python **CLI** (`main.py:parse_args`) — the two do not overlap.

## Status legend

- **Status: Implemented** — exists in `api/` today, verified directly against the source.
- **Status: Contract baseline** — not implemented yet. The shape is fixed by a backend issue (#1–#11, milestone "Book API v1"), not by the frontend mock; see "Contract baseline for unimplemented routes" below.

## Transport & deployment notes

- nginx (`app/nginx.conf`) only reverse-proxies `location /api/` to `http://api:8000` (the FastAPI container). Everything else falls through to the SPA (`try_files ... /index.html`).
- Every versioned route is mounted under `/api/v1` (`api/main.py:create_app`, `APIRouter(prefix="/api/v1")`). Unversioned `/api/health` and `/api/ready` aliases also exist (`include_in_schema=False`, kept only for the Compose healthcheck) but are not part of the documented contract.
- FastAPI's auto-generated `/docs` (Swagger UI), `/redoc`, and `/openapi.json` are enabled in-process but served at unprefixed paths, so they are **not reachable** through the nginx-proxied public URL — only routes under `/api/...` are forwarded. To browse the spec, use `openapi.yaml` in this directory (e.g. load it into a local Swagger UI/Redoc instance), or hit the `api` container directly during local development.
- No authentication and no CORS middleware exist anywhere in `api/` today. This applies to both the implemented and contract-baseline sections below.
- The `api` container is reachable only from other containers on the Compose `frontend`/`backend` networks (`docker-compose.yml`); it has no published host port. `web` (nginx) is the only container exposed to the host, on `${WEB_PORT:-8080}`.
- Error responses use RFC 9457 problem details, `Content-Type: application/problem+json`, body `{type, title, status, detail?, instance}` (`api/core/errors.py`); list endpoints return `{items, total, limit, offset}` (`api/presentation/schemas/common.py:Page`), `limit` capped at 200.

## Implemented (Today)

### System endpoints

#### `GET /api/v1/health`

**Status: Implemented**

No path/query parameters, no request body, no auth.

| Field | Type | Description |
| --- | --- | --- |
| `status` | `string` | Always `"ok"`. |

Status codes: `200` always.

Source: `api/presentation/routers/system.py:health`

#### `GET /api/v1/ready`

**Status: Implemented**

No path/query parameters, no request body, no auth. Runs `SELECT 1` through the async SQLAlchemy session (`DATABASE_URL`, `api/core/db.py`).

| Field | Type | Description |
| --- | --- | --- |
| `status` | `string` | `"ready"` when the `SELECT 1` check succeeds. |

Status codes:
- `200` — DB check succeeded, body `{"status": "ready"}`.
- `503` — the DB check raised (e.g. Postgres unreachable); `api/core/errors.py:StorageError` is caught and rendered as an `application/problem+json` body. Object-storage health joins this check once issue #3 lands.

This is also the endpoint Docker Compose's healthcheck polls for the `api` service (`docker-compose.yml`), via the unversioned `/api/ready` alias until issue #2 switches it to `/api/v1/ready`.

Source: `api/presentation/routers/system.py:ready`

## Contract baseline for unimplemented routes

Every other route (files, projects, sources, outline, runs) does not exist in `api/` yet. Its shape is **not** derived from the frontend mock any more — it is transcribed directly from backend issues #1–#11 (milestone "Book API v1"), each of which specifies its own migrations, service methods, request/response fields, status codes and error cases in detail. Those issues are canonical; `docs/openapi.yaml` is hand-aligned with them (issue #13) so the frontend can generate DTOs (`openapi-typescript`) ahead of the implementation, and per-operation descriptions there carry the design notes (outline flat-vs-tree, SSE event names, resume-based regenerate/export, etc.) that used to live in this file's now-removed "Planned" section.

Once issue #12 lands, `docs/openapi.yaml` becomes a generated artifact (`scripts/export_openapi.py` dumping `api.main:create_app`'s `app.openapi()`) and this section is rewritten into full resource-by-resource prose, the way the "Implemented" section above is written today. Until then, treat `docs/openapi.yaml` — not this file — as the reference for exact request/response shapes, and the issue linked from each operation's `x-issue` extension as the reference for *why* the shape is what it is.
