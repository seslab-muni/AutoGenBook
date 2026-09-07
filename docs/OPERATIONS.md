# Operations

## Install / build

Install Python dependencies from `requirements.txt`. (`requirements.txt`)

```bash
pip install -r requirements.txt
```

## Run locally

Run via the CLI entrypoint `main.py`. (`main.py:main`)

```bash
python main.py --mode book --input input/book/book_input.txt --out-dir output/book/out_book
```

The run context writes artifacts to `--out-dir` and stores metadata in `run_meta.json`. (`autogenbook/state.py:RunContext`, `autogenbook/llm_usage.py:write_run_meta`)

## Run in production

- Ensure `OPENROUTER_API_KEY` is set for OpenRouter or set `AUTOGENBOOK_LLM_BASE_URL` for local endpoints. (`openrouter_llm.py:OpenRouterLLM.__init__`)
- Install LuaLaTeX if you need PDF output. (`book_builder.py:compile_pdf`)
- Use `--audit-mode strict` for CI-style gating when audits are enabled. (`autogenbook/audit/latex_auditor.py:audit_latex`, `autogenbook/pipelines/paper_pipeline.py:run_paper`)

Deployment is not codified in runtime code paths; no container/orchestration logic is referenced by the CLI. (`main.py`, `autogenbook/orchestrator.py`).

## Docker stack

`docker compose up --build` starts six services (`docker-compose.yml`):

- `web`: nginx, the only container published to the host (`${WEB_BIND_HOST:-127.0.0.1}:${WEB_PORT:-8080}`, loopback-only by default); proxies to `api` and serves the `app/` frontend build. Also rate-limits `/api/` (`limit_req`/`limit_conn` in `app/nginx.conf`), since the API has no throttling of its own. (`docker-compose.yml:web`, `app/nginx.conf`)
- `api`: FastAPI (`api/main.py:create_app`), on `frontend`+`backend`; runs `alembic -c api/alembic.ini upgrade head` before `uvicorn api.main:app` on container start, and is health-gated on `GET /api/v1/ready` (`api/presentation/routers/system.py:ready`), which checks the database through `api/core/db.py:get_session`. (`docker-compose.yml:api`)
- `worker`: the generation worker (`python -m api.worker`, `api/worker/__main__.py:main`), `backend`-only, `restart: unless-stopped`; shares the `runs_data` volume with `api` so run directories written by the worker are readable by the API. (`docker-compose.yml:worker`)
- `db`: `postgres:16-alpine`, `backend`-only, health-gated on `pg_isready`. (`docker-compose.yml:db`)
- `minio`: S3-compatible object storage, `backend`-only (no host port — uploads/downloads are proxied through `api`, not accessed directly), health-gated on `/minio/health/live`. (`docker-compose.yml:minio`)
- `minio-init`: one-shot `mc` job that creates the upload bucket; `api` and `worker` wait on its successful completion before starting. (`docker-compose.yml:minio-init`)

Named volumes: `postgres_data` (Postgres data directory), `minio_data` (object store data), `runs_data` (shared `/app/runs` run directories between `api` and `worker`), `kb_extract_cache` (`worker`-only `/app/kb_cache`: `rag_kb.py`'s content-hash-keyed cache of extracted-but-not-yet-chunked document text, deliberately outside `runs_data` so it survives `sweep_stale_work_dirs` deleting individual runs and is shared across every project/run rather than scoped to one). (`docker-compose.yml`)

Configuration for `api`/`worker` (`api/core/settings.py:Settings`) comes entirely from environment variables injected by `docker-compose.yml`, sourced from `.env` (copy `.env.example` first); containers do not read `.env` files themselves. Key variables: `DATABASE_URL`, `S3_ENDPOINT_URL`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`/`S3_BUCKET`, `RUNS_DIR`, `MAX_UPLOAD_MB`, `KB_EXTRACT_CACHE_DIR`, `WORKER_CONCURRENCY`/`WORKER_POLL_INTERVAL_S`/`WORKER_STALE_S`, `RUNS_RETENTION_DAYS`, plus the CLI's own `OPENROUTER_API_KEY`/`AUTOGENBOOK_LLM_BASE_URL`/`AUTOGENBOOK_LLM_API_KEY`/`AUTOGENBOOK_FORCE_MINI_MODEL`/`TAVILY_API_KEY`/`MCP_GATEWAY_ENABLE`, passed through to both `api` and `worker`. (`.env.example`, `api/core/settings.py:Settings`)

### ⚠️ No authentication - do not expose beyond localhost

`/api/v1` has no authentication and no CORS middleware (`api/main.py`'s module docstring); `ProjectRepository.list`/`.get` have no owner filter, so any client that can reach the API can read/write every project, upload arbitrary files up to `MAX_UPLOAD_MB` with no per-client quota, and start CLI runs that spend `OPENROUTER_API_KEY` budget (issue #50). This is a deliberate, tracked gap (auth is a stub pending its own design, issue #16), not a bug to work around.

Until real auth exists:

- Leave `WEB_BIND_HOST=127.0.0.1` (the default) so the stack is reachable only from the host it runs on. Only change it to `0.0.0.0` if you put a real auth/authorization layer in front (a reverse proxy with its own auth, a VPN, etc.) - never expose the stack to an untrusted network as-is.
- `app/nginx.conf` rate-limits `/api/` (`limit_req`/`limit_conn`) as a spend/DoS backstop, not a substitute for auth.
- There's no per-client upload/run quota beyond "one active run per project" - unlimited projects means effectively no cap on concurrent LLM spend from a single trusted-network client.

## Logging and observability

- Console and file logs go to `out_dir/logs/run.log`. (`autogenbook/logging.py:get_logger`, `autogenbook/paths.py:default_run_paths`)
- LLM usage is appended to `out_dir/llm_usage.jsonl`. (`autogenbook/llm_usage.py:log_usage`)
- Audits write `audit_report.json` when enabled. (`autogenbook/audit/latex_auditor.py:audit_latex`)

## Scaling guidance

Runs are single-process and synchronous; scale by running multiple independent CLI processes, each with its own `--out-dir`. (`autogenbook/pipelines/*`, `book_builder.py:generate_contents`)

## Backup / restore

- Preserve `--out-dir` to keep section files, structure graphs, and logs. (`autogenbook/state.py:RunContext`, `book_builder.py:generate_contents`)
- Preserve `.kb_cache` inside `--out-dir` to avoid rebuilding KBs. (`rag_kb.py:KnowledgeBase.build_from_directory`)
- In the Docker stack, also preserve the separate `kb_extract_cache` volume (`/app/kb_cache`) — the content-hash-keyed cache of extracted document text, shared across every project/run rather than scoped to one `--out-dir`. (`docker-compose.yml`, `rag_kb.py:KnowledgeBase.build_from_directory`)

## Security hardening checklist

- Keep API keys in environment variables, not in files. (`openrouter_llm.py:OpenRouterLLM.__init__`, `mcp_gateway.py:MCPGatewayClient.__init__`)
- Disable MCP gateway when not needed: `MCP_GATEWAY_ENABLE=0`. (`mcp_gateway.py:MCPGatewayClient.__init__`)
- Use local KB sources you trust; retrieval sanitizes some prompt-injection patterns but does not guarantee safety. (`autogenbook/retrieval/sanitize.py:sanitize_context_text`)
- Scientist mode patching enforces strict diff safety checks. (`autogenbook/runner/patch_apply.py:apply_unified_diff`)
