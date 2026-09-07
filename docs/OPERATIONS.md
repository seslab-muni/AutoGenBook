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

- `web`: nginx, the only container published to the host (`${WEB_PORT:-8080}`); proxies to `api` and serves the `app/` frontend build. (`docker-compose.yml:web`)
- `api`: FastAPI (`api/main.py:create_app`), on `frontend`+`backend`; runs `alembic -c api/alembic.ini upgrade head` before `uvicorn api.main:app` on container start, and is health-gated on `GET /api/v1/ready` (`api/presentation/routers/system.py:ready`), which checks the database through `api/core/db.py:get_session`. (`docker-compose.yml:api`)
- `worker`: the generation worker (`python -m api.worker`, `api/worker/__main__.py:main`), `backend`-only, `restart: unless-stopped`; shares the `runs_data` volume with `api` so run directories written by the worker are readable by the API. (`docker-compose.yml:worker`)
- `db`: `postgres:16-alpine`, `backend`-only, health-gated on `pg_isready`. (`docker-compose.yml:db`)
- `minio`: S3-compatible object storage, `backend`-only (no host port — uploads/downloads are proxied through `api`, not accessed directly), health-gated on `/minio/health/live`. (`docker-compose.yml:minio`)
- `minio-init`: one-shot `mc` job that creates the upload bucket; `api` and `worker` wait on its successful completion before starting. (`docker-compose.yml:minio-init`)

Named volumes: `postgres_data` (Postgres data directory), `minio_data` (object store data), `runs_data` (shared `/app/runs` run directories between `api` and `worker`). (`docker-compose.yml`)

Configuration for `api`/`worker` (`api/core/settings.py:Settings`) comes entirely from environment variables injected by `docker-compose.yml`, sourced from `.env` (copy `.env.example` first); containers do not read `.env` files themselves. Key variables: `DATABASE_URL`, `S3_ENDPOINT_URL`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`/`S3_BUCKET`, `RUNS_DIR`, `MAX_UPLOAD_MB`, `WORKER_CONCURRENCY`/`WORKER_POLL_INTERVAL_S`/`WORKER_STALE_S`, `RUNS_RETENTION_DAYS`, plus the CLI's own `OPENROUTER_API_KEY`/`AUTOGENBOOK_LLM_BASE_URL`/`AUTOGENBOOK_LLM_API_KEY`/`AUTOGENBOOK_FORCE_MINI_MODEL`/`TAVILY_API_KEY`/`MCP_GATEWAY_ENABLE`, passed through to both `api` and `worker`. (`.env.example`, `api/core/settings.py:Settings`)

## Logging and observability

- Console and file logs go to `out_dir/logs/run.log`. (`autogenbook/logging.py:get_logger`, `autogenbook/paths.py:default_run_paths`)
- LLM usage is appended to `out_dir/llm_usage.jsonl`. (`autogenbook/llm_usage.py:log_usage`)
- Audits write `audit_report.json` when enabled. (`autogenbook/audit/latex_auditor.py:audit_latex`)

## Scaling guidance

Runs are single-process and synchronous; scale by running multiple independent CLI processes, each with its own `--out-dir`. (`autogenbook/pipelines/*`, `book_builder.py:generate_contents`)

## Backup / restore

- Preserve `--out-dir` to keep section files, structure graphs, and logs. (`autogenbook/state.py:RunContext`, `book_builder.py:generate_contents`)
- Preserve `.kb_cache` inside `--out-dir` to avoid rebuilding KBs. (`rag_kb.py:KnowledgeBase.build_from_directory`)

## Security hardening checklist

- Keep API keys in environment variables, not in files. (`openrouter_llm.py:OpenRouterLLM.__init__`, `mcp_gateway.py:MCPGatewayClient.__init__`)
- Disable MCP gateway when not needed: `MCP_GATEWAY_ENABLE=0`. (`mcp_gateway.py:MCPGatewayClient.__init__`)
- Use local KB sources you trust; retrieval sanitizes some prompt-injection patterns but does not guarantee safety. (`autogenbook/retrieval/sanitize.py:sanitize_context_text`)
- Scientist mode patching enforces strict diff safety checks. (`autogenbook/runner/patch_apply.py:apply_unified_diff`)
