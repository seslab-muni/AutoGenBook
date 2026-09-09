# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AutoGenBook is a Python CLI (`main.py`) that generates long-form documents (books, papers, presentations, proposals, reviews, and an "scientist" experiment+writeup loop) from short TXT specs, using mode-specific pipelines that build an explicit document graph, inject RAG/web retrieval context, generate leaf-section content via LLM agents validated against Pydantic schemas, and assemble Markdown (default) or LaTeX/PDF output.

The `README.md` at repo root is an exhaustive, source-linked reference (every claim cites the file:function it comes from) covering all CLI flags, environment variables, per-mode examples, output artifacts, and prompt-pack layout — treat it as the primary spec and prefer reading the relevant section there over re-deriving behavior from scratch. `docs/ARCHITECTURE.md`, `docs/DEVELOPER_GUIDE.md`, `docs/API_REFERENCE.md`, `docs/CONFIGURATION.md`, `docs/OPERATIONS.md`, and `docs/TROUBLESHOOTING.md` go deeper on their respective topics; `docs/INDEX.md` maps all of them.

## Commands

```bash
# Install deps (Python 3.12; also see uv.lock / pyproject.toml)
pip install -r requirements.txt

# Run all unit tests
python -m unittest

# Run a single test file / test case / test method
python -m unittest tests.test_book_citations
python -m unittest tests.test_book_citations.BookCitationTests
python -m unittest tests.test_book_citations.BookCitationTests.test_apply_iso690_alias_points_to_v3

# Prompt pack completeness check (run after editing any prompts/<mode>/*.md file)
python -m autogenbook.smoke_prompts

# Schema smoke tests
python -m autogenbook.schemas.smoke

# End-to-end smoke run (requires OPENROUTER_API_KEY unless AUTOGENBOOK_SMOKE_FAST=1)
python -m autogenbook.smoke_test

# Scan a LaTeX compile log for common errors
python scripts/check_latex_log.py <file.log>

# API service: install deps, run its pytest suite, apply DB migrations
pip install -r api/requirements-dev.txt
pytest tests/api
DATABASE_URL="postgresql+psycopg://autogenbook:autogenbook@localhost:5432/autogenbook" \
  AUTH_JWT_SECRET="$(openssl rand -hex 32)" \
  alembic -c api/alembic.ini upgrade head

# Minimal real run (Markdown-first, no PDF)
export OPENROUTER_API_KEY="..."
python main.py --mode book --input input/book/book_input.txt --out-dir output/book/out_book --no-pdf
```

There is no linter/formatter configured for the Python code. The frontend (`app/`) is a Vite + React 19 (strict TypeScript) app on TanStack Router, TanStack Query, Zustand, and shadcn/ui on Tailwind 4:

```bash
cd app
pnpm install
pnpm lint      # eslint + tsc --noEmit
pnpm format    # prettier --write .
pnpm test      # vitest
pnpm test:ci   # vitest run (single pass, for CI)
pnpm build     # tsc -b && vite build
pnpm dev       # dev server on :3000

# End-to-end/a11y smoke (Playwright, app/e2e/) - against the real Docker Compose stack, not
# Vitest/MSW; see app/README.md's "End-to-end tests" section for the one-time seeding step.
docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d --wait
pnpm e2e
```

### Docker stack (web UI + FastAPI + Postgres + MinIO + worker)

```bash
cp .env.example .env   # set OPENROUTER_API_KEY if generation is enabled, and AUTH_JWT_SECRET (openssl rand -hex 32) - the API refuses to boot without it
docker compose up --build
# Seed the first account (no self-service signup):
docker compose run --rm api python -m api.scripts.users create --email you@example.com --name "Your Name"
```

### CERIT-SC Kubernetes deployment

```bash
python scripts/deploy.py            # dry-run: show what would be built/pushed/applied
python scripts/deploy.py --apply    # build/push/apply, prompting first
python scripts/deploy.py --help     # every flag, incl. --sync-secrets, --force, --no-rollback
```

Automates the day-to-day redeploy part of `docs/DEPLOY_GUIDE.md` (that doc still covers
first-time cluster setup) — diffs HEAD against whatever commit is actually live per `kubectl`,
tags images by git SHA, and rolls every touched Deployment back on a failed rollout.

Nginx (`web`, port 8080 by default) is the only container exposed to the host; it proxies `/api/...` to `api` (FastAPI, `api/main.py`), which talks to `db` (Postgres) and `minio` (S3-compatible object store) on an internal-only network. `minio-init` is a one-shot job that creates the upload bucket before `api`/`worker` start. `worker` (`python -m api.worker`) runs the CLI as a subprocess against a `runs_data` volume shared with `api` (the API reads run directories for events/resume; the worker writes them). Every `/api/v1` route requires a login session (`POST /api/v1/auth/login`, an httpOnly cookie) except that route itself and the health/ready probes (issue #96) - accounts are managed with `api/scripts/users.py`, never self-service signup. The API implements the full project/generation surface — files, projects, sources, outline, runs (including SSE run-event streaming) — alongside system health checks (`/api/v1/health`, `/api/v1/ready`, plus legacy `/api/health`/`/api/ready` aliases kept only for the Compose healthcheck); `app/` has real screens wired to these endpoints (a login screen, a projects hub, and per-project source/outline/editor/runs views). See `docs/WEB_API_REFERENCE.md` / `docs/openapi.yaml` for the full endpoint contract and `docs/OPERATIONS.md` for the full service/volume breakdown (including the worker/CLI environment variables) rather than re-deriving it here.

## Architecture

Control flow: `main.py:parse_args` → `autogenbook/orchestrator.py:run` dispatches by `--mode` to one pipeline in `autogenbook/pipelines/{book,paper,presentation,scientist,proposal,reviewer}_pipeline.py`. Each pipeline:

1. Loads a prompt pack for its mode via `autogenbook/prompts/<mode>_loader.py` (files live in `prompts/<mode>/`; loaders declare required filenames and fail fast if any are missing).
2. Builds/loads a document graph (`autogenbook/graph/doc_graph.py`, persisted as `structure_graph.json` for resume via `--resume`).
3. Subdivides oversized outline nodes into leaf sections with page budgets.
4. For each leaf section, runs LLM agents (`autogenbook/agents/*`, all extending `autogenbook/agents/base.py:BaseAgent`) that build prompts from the pack, call the LLM, and validate/repair JSON output against a Pydantic schema in `autogenbook/schemas/`.
5. Assembles the final document: Markdown by default for book/paper (via `book_builder.py`), with optional LaTeX/PDF conversion through pandoc + LuaLaTeX; `--legacy-tex` reverts to the older LaTeX-first generation path.

Everything runs synchronously/sequentially per run — no async or threading in the core generation loop; subprocesses are used only for LaTeX compilation and scientist-mode experiments.

Key subsystems:
- **Retrieval**: `rag_kb.py:KnowledgeBase` builds a local BM25 index over PDF/DOCX/PPTX/MD/TXT files (`--kb-dir`), producing chunks with stable `rid`/`cite_key` IDs. `autogenbook/retrieval/manager.py:RetrievalManager` merges local KB results with optional web retrieval (`autogenbook/retrieval/mcp_papers.py` via `mcp_gateway.py`, and/or `autogenbook/retrieval/tavily.py`), normalizing everything into `RetrievalItem`.
- **Citations & auditing**: `autogenbook/citations/` extracts/normalizes citations and builds BibTeX; `autogenbook/audit/latex_auditor.py:audit_latex` flags unknown citations, missing figures, and numeric claims lacking evidence (`--audit-mode {off,warn,strict}`; strict blocks PDF emission on errors).
- **State/logging**: `autogenbook/state.py:RunContext` tracks run id and output paths; `autogenbook/llm_usage.py` writes `run_meta.json` and `llm_usage.jsonl` (per-call cost/usage) for every run.
- **LLM client**: `openrouter_llm.py:OpenRouterLLM` — OpenAI-compatible client defaulting to OpenRouter; `--llm-base-url` / `AUTOGENBOOK_LLM_BASE_URL` redirect it to any OpenAI-compatible endpoint (e.g. LM Studio). Proposal and reviewer modes support per-role model/base-url overrides (LLM1..LLM5).

### Repo layout notes

- `autogenbook/` (repo root) is the real package used at runtime; `src/autogenbook/` is an unrelated stub left over from `uv init` scaffolding (just a placeholder `main()`) and is not part of the actual pipelines — don't confuse the two when searching for implementation.
- `prompts/<mode>/` prompt packs are plain Markdown edited directly; keep `{GLOBAL_SYSTEM_POLICY}`/`{GLOBAL_EVIDENCE_INSTRUCTIONS}` placeholders intact, and re-run `python -m autogenbook.smoke_prompts` after edits. Book/paper prompts have `_md.md` variants used by the Markdown-first path; the non-`_md` versions are for `--legacy-tex`.
- `app/` is a separate pnpm/Vite/React 19 (strict TypeScript) frontend — TanStack Router (file-based routes in `src/routes`, generated `src/routeTree.gen.ts` committed), TanStack Query, Zustand (`src/stores/`), shadcn/ui on Tailwind 4 (`src/components/ui/`, generated by `pnpm dlx shadcn add`) — served by nginx in the Docker stack; it is not part of the Python package. Feature code lives under `src/features/<projects|sources|outline|editor|runs|exports>`, with real screens wired to the live API (e.g. `src/routes/index.tsx` renders the projects hub, `src/routes/p.$projectId.runs.$runId.tsx` the run detail view); see `app/README.md` for current screen/feature coverage and `docs/WEB_UI.md` for the screen/state-ownership overview. `app/e2e/` holds Playwright end-to-end and accessibility smoke tests that run against the full Docker Compose stack (with the fake CLI, `tests/api/fake_cli.py`) in CI on `main` and nightly — see `app/README.md`'s "End-to-end tests" section for the local command.
- `api/` is a FastAPI service (`api/core`, `api/domain`, `api/application`, `api/infrastructure`, `api/presentation`, `api/worker`) that the Docker Compose stack builds from the root `Dockerfile`; see `docs/WEB_API_REFERENCE.md` for the implemented endpoint surface (files, projects, sources, outline, runs, SSE, plus system health checks) rather than re-deriving it here. API-only Python deps live in `api/requirements.txt` (dev extras in `api/requirements-dev.txt`) so upstream CLI-fork merges of the root `requirements.txt` never conflict. Its own tests live in `tests/api/` and run via `pytest` (`pytest tests/api`), separate from the CLI's `python -m unittest` suite.
- `output/`, `input/`, `tests/out_smoke*` contain generated run artifacts and sample/test fixtures, not source.
