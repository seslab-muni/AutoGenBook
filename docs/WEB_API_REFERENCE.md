# Web API Reference (HTTP/REST)

This document describes the HTTP API exposed by the FastAPI service in `api/` (`api/main.py:create_app`), reached through the nginx-fronted Docker Compose stack at `/api/...` (`docker-compose.yml`, `app/nginx.conf.template`). A machine-readable companion spec lives at `openapi.yaml` in this same directory.

This is a different document from [`API_REFERENCE.md`](API_REFERENCE.md), which covers the Python **CLI** (`main.py:parse_args`) — the two do not overlap.

## Status

Every endpoint below is implemented in `api/` today and has request/response coverage in `tests/api/` (some cross-cutting concerns — `Last-Event-ID` resume semantics on the SSE stream, the `worker` process itself, and the real MinIO/S3 adapter behind the storage interface — are exercised only indirectly or with fakes, not end-to-end). `docs/openapi.yaml` is a **generated artifact** (`scripts/export_openapi.py`, dumping `api.main:create_app().openapi()`) — regenerate it after any router/schema change instead of hand-editing it; this file carries the request/response prose and design notes the raw schema doesn't.

## Transport & deployment notes

- nginx (`app/nginx.conf.template`) only reverse-proxies `location /api/` to `http://api:8000` (the FastAPI container). Everything else falls through to the SPA (`try_files ... /index.html`).
- Every versioned route is mounted under `/api/v1` (`api/main.py:create_app`, `APIRouter(prefix="/api/v1")`). Unversioned `/api/health` and `/api/ready` aliases also exist (`include_in_schema=False`, kept only for the Compose healthcheck) but are not part of the documented contract.
- FastAPI's auto-generated `/docs` (Swagger UI), `/redoc`, and `/openapi.json` are enabled in-process but served at unprefixed paths, so they are **not reachable** through the nginx-proxied public URL — only routes under `/api/...` are forwarded. To browse the spec, use `openapi.yaml` in this directory (e.g. load it into a local Swagger UI/Redoc instance), or hit the `api` container directly during local development.
- No authentication and no CORS middleware exist anywhere in `api/`. `ProjectRecord.owner_id` (`api/domain/models.py:Project.owner_id`) is reserved for later auth work — it's always `None` today (`api/presentation/routers/projects.py:current_owner`) and plays no part in access control.
- The `api` container is reachable only from other containers on the Compose `frontend`/`backend` networks (`docker-compose.yml`); it has no published host port. `web` (nginx) is the only container exposed to the host, on `${WEB_PORT:-8080}`.
- Error responses use RFC 9457 problem details, `Content-Type: application/problem+json`, body `{type, title, status, detail?, instance}` (`api/core/errors.py`). `NotFound`→404, `Conflict`→409, `ValidationFailed`/request validation→422, `PayloadTooLarge`→413, `StorageError`→503, anything unexpected→500.
- List endpoints return `{items, total, limit, offset}` (`api/presentation/schemas/common.py:Page`); `limit` defaults to 50 and is capped at 200 unless a route documents a different default/cap below.
- All request/response bodies are camelCase on the wire, snake_case in Python (`api/presentation/schemas/common.py:BaseSchema`, `alias_generator=to_camel`).

## System endpoints

#### `GET /api/v1/health`

No path/query parameters, no request body, no auth.

| Field | Type | Description |
| --- | --- | --- |
| `status` | `string` | Always `"ok"`. |

Status codes: `200` always.

Source: `api/presentation/routers/system.py:health`

#### `GET /api/v1/ready`

No path/query parameters, no request body, no auth. Runs `SELECT 1` through the async SQLAlchemy session, then calls the object-storage adapter's `healthcheck()`.

| Field | Type | Description |
| --- | --- | --- |
| `status` | `string` | `"ready"` when both checks succeed. |

Status codes:
- `200` — DB and object-storage checks both succeeded, body `{"status": "ready"}`.
- `503` — a dependency is unreachable; `api/core/errors.py:StorageError` rendered as `application/problem+json`.

This is also the endpoint Docker Compose's healthcheck polls for the `api` service, via the unversioned `/api/ready` alias.

Source: `api/presentation/routers/system.py:ready`

## Files

Standalone file storage (MinIO/S3-backed via `api/infrastructure/storage/s3.py`); every other resource (sources, run artifacts) references a file by `fileId` only. Files are never soft-deleted — `DELETE` is a hard delete, blocked while anything still references the file.

#### `POST /api/v1/files`

Multipart upload (`file` field). Rejects a body over `MAX_UPLOAD_MB` (env-configured; default in `api/core/settings.py`) mid-stream — bytes already read still count against the client's bandwidth, but nothing partial is left in storage.

| Field | Type | Description |
| --- | --- | --- |
| `id` | `uuid` | |
| `filename` | `string` | Sanitized to `[A-Za-z0-9._-]`; path separators stripped. |
| `contentType` | `string` | From the multipart part, or guessed from the filename when the client sent `application/octet-stream`/nothing. |
| `sizeBytes` | `integer` | |
| `sha256` | `string` | Hex digest, computed while streaming to storage. |
| `kind` | `string` | Always `"upload"` here (`"artifact"` is used internally for run-produced files). |
| `kbEligible` | `boolean` | `true` for `.pdf`/`.docx`/`.pptx`/`.md`/`.txt` — the extensions the CLI's knowledge base indexes. |
| `createdAt` | `datetime` | |

Status codes: `201`; `413` if the upload exceeds the configured size limit.

Source: `api/application/files.py:FileService.upload`, `api/presentation/routers/files.py:upload_file`

#### `GET /api/v1/files`

Query: `limit` (default 50, max 200), `offset` (default 0). Returns a `Page<File>`.

Status codes: `200`.

Source: `api/presentation/routers/files.py:list_files`

#### `GET /api/v1/files/{fileId}`

Returns the same `File` shape as upload. Status codes: `200`; `404` if the id doesn't exist.

Source: `api/presentation/routers/files.py:get_file`

#### `GET /api/v1/files/{fileId}/content`

Streams the raw bytes from object storage. `Content-Type` is the file's stored `contentType`; `Content-Disposition: attachment; filename*=UTF-8''<name>`, `Content-Length`, and `ETag: "<sha256>"` headers are set.

Status codes: `200`; `404` if the id doesn't exist.

Source: `api/presentation/routers/files.py:get_file_content`

#### `DELETE /api/v1/files/{fileId}`

Status codes: `204`; `404` if the id doesn't exist; `409` if the file is still referenced (`FileRepository.is_referenced` — attached as a project source, a run artifact, etc.).

Source: `api/application/files.py:FileService.delete`

## Projects

A project is a book/paper spec: metadata, its sources, and its outline, all addressable through their own sub-resources below. `ProjectSummary` (the list shape) omits `sources`/`outline` and instead reports counts; `Project` (the detail shape) embeds both in full.

Shared fields (both `ProjectCreate`/`ProjectUpdate` and the `Project`/`ProjectSummary` responses): `title`, `subtitle`, `authors: string[]`, `topic`, `targetAudience` (`undergraduate|graduate|phd_researcher|industry_practitioner`, default `graduate`), `totalPagesBudget` (5–2000, default 350), `equationFrequencyLevel` (1–5, default 4), `doConsiderOutline`/`doConsiderPreviousSections` (booleans, default `true`), `outputFormat` (`markdown|latex|pdf`, default `markdown`), `maxOutlineLevels` (1–5, default 3), `additionalRequirements` (nullable string).

#### `GET /api/v1/projects`

Query: `limit` (default 50, max 200), `offset` (default 0). Returns a `Page<ProjectSummary>`, each row adding `sourcesCount`, `outlineNodeCount`, `lastRunId`, `createdAt`, `updatedAt`.

Status codes: `200`.

Source: `api/application/projects.py:ProjectService.list`, `api/presentation/routers/projects.py:list_projects`

#### `POST /api/v1/projects`

Body: the shared fields above, plus two wizard-only conveniences popped off before `ProjectService.create` ever sees them:
- `sources: SourceCreate[]` — attached atomically with creation; if any entry fails (unknown `fileId`, not KB-eligible, duplicate), the just-created project is deleted and the error is re-raised so the client never sees a half-populated project.
- `outline: OutlineTreeReplaceNode[]` — authored atomically via `OutlineService.replace`.

Returns the full `Project` (with `sources`/`outline` embedded).

Status codes: `201`; `422` on validation failure (including a source that isn't KB-eligible); `409` if a source's file is already attached to the project.

Source: `api/presentation/routers/projects.py:create_project`

#### `GET /api/v1/projects/{projectId}`

Returns the full `Project`, with `outline` embedded as a tree (`OutlineNodeTree`, nested `children`) and `sources` as the full `Source` list.

Status codes: `200`; `404` if the id doesn't exist.

Source: `api/presentation/routers/projects.py:get_project`

#### `PATCH /api/v1/projects/{projectId}`

Body: any subset of the shared fields above (`extra="forbid"` — `sources`/`outline` have their own endpoints and are rejected with `422` if sent here, as is any other unknown key). Partial update (`exclude_unset`).

Status codes: `200`; `404`; `422`.

Source: `api/application/projects.py:ProjectService.update`, `api/presentation/routers/projects.py:update_project`

#### `DELETE /api/v1/projects/{projectId}`

Status codes: `204`; `404`.

Source: `api/presentation/routers/projects.py:delete_project`

#### `POST /api/v1/projects/{projectId}/duplicate`

Deep-copies metadata, sources (by reference to the same files), and the outline tree (fresh ids, `cliKey` cleared) into a new project titled `"<original> (Copy)"`. Returns the new `Project`.

Status codes: `201`; `404` if the source project doesn't exist.

Source: `api/application/projects.py:ProjectService.duplicate`, `api/application/outline.py:OutlineService.duplicate_from`, `api/presentation/routers/projects.py:duplicate_project`

#### `GET /api/v1/projects/{projectId}/spec`

Renders the project + its current outline into a CLI-consumable spec — the same shape a `POST /runs` prepares internally, exposed here for inspection/download.

Query: `format` (`txt` default | `json`), `includeOutline` (bool, default `true`, `txt` only).

- `format=txt` — the natural-language spec (`SpecRenderer.render`); `includeOutline=false` omits outline headings so the CLI's own outline-structuring LLM step runs instead of parsing the embedded headings verbatim. Returned as `text/plain`.
- `format=json` — the CLI's `book_structure.json` shape (`StructureBuilder.build`), outline nodes locked against further LLM subdivision. Returned as `application/json`.

Status codes: `200`; `404` if the project doesn't exist.

Source: `api/application/book_spec.py:SpecRenderer,StructureBuilder`, `api/presentation/routers/projects.py:get_project_spec`

## Sources

Files attached to a project as RAG sources, mounted under `/api/v1/projects/{projectId}/sources`. Soft-deleted: `remove` sets `deletedAt` rather than issuing a SQL `DELETE`, so a removed source disappears from every read (`get`/`list`/the project's embedded `sources`) but the row (and its `fileId` reference) survives for audit and so a file can't be re-attached over a stale row.

`Source` fields: `id`, `fileId`, `name`/`sizeBytes` (from the referenced `File`), `type` (`pdf|doc|ppt|md|txt|slides|arxiv|notes|bibtex|latex|url|book|dataset` — inferred from the file extension when omitted on create), `chunksCount` (nullable — populated once a run indexes it into the KB), `status` (`ready|indexed|error`), `uploadDate`, plus free-text `authors`/`year`/`doi`/`url`/`description`.

#### `GET /api/v1/projects/{projectId}/sources`

Query: `limit` (default 50, max 200), `offset` (default 0). Returns `Page<Source>`.

Status codes: `200`; `404` if the project doesn't exist.

#### `POST /api/v1/projects/{projectId}/sources`

Body: `fileId` (required) + optional `type`/`authors`/`year`/`doi`/`url`/`description`.

Status codes: `201`; `404` if the project or `fileId` doesn't exist; `422` if the file isn't KB-eligible (`kbEligible=false`); `409` if the file is already attached to this project.

#### `GET /api/v1/projects/{projectId}/sources/{sourceId}`

Status codes: `200`; `404` if the project or source doesn't exist (including a soft-deleted one).

#### `PATCH /api/v1/projects/{projectId}/sources/{sourceId}`

Body: any subset of `authors`/`year`/`doi`/`url`/`description` (partial update). `type`/`fileId` are immutable after creation.

Status codes: `200`; `404`.

#### `DELETE /api/v1/projects/{projectId}/sources/{sourceId}`

Soft delete (see above).

Status codes: `204`; `404`.

Source (all five): `api/application/sources.py:SourceService`, `api/presentation/routers/sources.py`

## Outline

Outline nodes, mounted under `/api/v1/projects/{projectId}/outline`. The **flat** shape (`parentId` + `orderIndex`) is canonical; `?format=tree` (nested `children`) is a rendering convenience derived from it on every read. `level`, `sectionNumber`, and `cliKey` are always server-derived from the current tree shape (`api/domain/outline.py:assign_positions`) — never client-supplied. Deletes are soft (`deletedAt` set on the whole subtree via `delete_subtree`); reads only ever see live rows.

`OutlineNode` fields: `id`, `parentId`, `orderIndex`, `cliKey` (nullable — set once a run's CLI graph is imported back), `title`, `summary`, `level`, `sectionNumber`, `status` (`not_started|drafting|review_ready|compiled`), `targetPages`, `wordBudget` (`= 350 × targetPages` when not explicit), `actualWords` (word count of `contentMarkdown`, recomputed server-side whenever it changes), `equationDensityLevel` (1–5), `mathLevel` (`introductory|rigorous|formal_proof|applied`), `subPrompt`, `contentMarkdown`/`contentLatex`, `ragCitations`, `reviewerScore`/`reviewerNotes`, `structureLocked`, timestamps.

#### `GET /api/v1/projects/{projectId}/outline`

Query: `format` (`flat` default | `tree`), `limit` (default 1000, max 5000 — a whole outline is read/edited as one unit, unlike files/projects there's no natural page size), `offset` (default 0). Returns `Page<OutlineNode>` or `Page<OutlineNodeTree>`.

Status codes: `200`; `404` if the project doesn't exist.

#### `PUT /api/v1/projects/{projectId}/outline`

Full-tree replace: body is `OutlineTreeReplaceNode[]` (nested, no ids — ids are minted on write), replacing every existing node. Enforces `project.maxOutlineLevels`. Returns the new flat `Page<OutlineNode>` (`limit=offset=` sized to the result, not paginated).

Status codes: `200`; `404`; `422` if the tree would exceed `maxOutlineLevels`.

#### `POST /api/v1/projects/{projectId}/outline`

Creates one node. Body: `parentId` (nullable), `title`, `orderIndex` (nullable — appended after existing siblings when omitted), `summary`, `targetPages`, `subPrompt`, `mathLevel` (default `rigorous`), `equationDensityLevel` (defaults to the project's `equationFrequencyLevel`).

Status codes: `201`; `404` if the project or `parentId` doesn't exist; `422` if the new depth would exceed `maxOutlineLevels`.

#### `GET /api/v1/projects/{projectId}/outline/{nodeId}`

Status codes: `200`; `404` if the project or node doesn't exist.

#### `PATCH /api/v1/projects/{projectId}/outline/{nodeId}`

Partial update (`extra="forbid"` — `level`/`sectionNumber`/`cliKey`/`actualWords` are server-derived and rejected with `422` if sent, as is any other unknown key). Sending `parentId` and/or `orderIndex` re-parents/reorders the node (and re-sequences old and new sibling lists); moving a node into its own subtree, or to a depth that would exceed `maxOutlineLevels`, is rejected.

Status codes: `200`; `404` if the project/node/new-parent doesn't exist; `422` on the validation cases above.

#### `DELETE /api/v1/projects/{projectId}/outline/{nodeId}`

Soft-deletes the node and its entire subtree.

Status codes: `204`; `404`.

Source (all six): `api/application/outline.py:OutlineService`, `api/domain/outline.py`, `api/presentation/routers/outline.py`

## Runs

Generation runs: driving the CLI as a subprocess, streaming its progress, and syncing its output back into outline nodes/files. `RunService` (API-side: create/list/get/cancel/export/regenerate/events) is called from the routers below; `GenerationService` (worker-side, `api/worker/__main__.py`) is a separate process that actually claims queued runs and executes them — the two never run in the same process.

`Run` fields: `id`, `projectId`, `kind` (`full|regenerate_section|export`), `status` (`queued|running|succeeded|failed|cancelled`), `options` (the request options echoed back, plus `promptModifier` for a `regenerate_section` run), `baseRunId`/`targetNodeId` (nullable — set for `regenerate_section`/`export`), `exitCode`, `error`, `totalTokens`/`totalCostUsd` (nullable, summed from the CLI's `run_meta.json`), `queuedAt`/`startedAt`/`finishedAt`, `resumable` (`false` once the run's work directory has been swept, `RUNS_RETENTION_DAYS` after it finished — a swept run can no longer be the base of a `regenerate`/`export`).

Only one active (`queued`/`running`) run per project at a time; every create/regenerate/export endpoint below returns `409` if the project already has one.

#### `POST /api/v1/projects/{projectId}/runs`

Body (`RunOptionsIn`, `extra="forbid"`): `outline` (`project` default — use the project's own outline | `generate` — let the CLI structure it), `outputFormat` (nullable — defaults to the project's own `outputFormat`), `allowSubdivision`, `enableWebRag`, `auditBook`, `auditBookMode` (`off|warn|strict`, default `warn`), `legacyTex`, `rebuildKb`, `failFastSchema`, `resume`, `exportTexOnly` (all booleans, default `false`).

`legacyTex` and `auditBook` both require the resolved `outputFormat` (the explicit body value, or the project's own if omitted) to be `latex` or `pdf` — with `markdown`, `legacyTex` would otherwise "succeed" with no document assembled at all, and `auditBook` would silently be a no-op (both need a `tex_path` the markdown-only assembly path never produces).

Status codes: `202`; `404` if the project doesn't exist; `409` if it already has an active run; `422` if `legacyTex` or `auditBook` is combined with a `markdown` output format.

Source: `api/application/runs.py:RunService.create`

#### `GET /api/v1/projects/{projectId}/runs`

Query: `limit` (default 50, max 200), `offset` (default 0). Returns `Page<Run>`.

Status codes: `200`; `404` if the project doesn't exist.

Source: `api/application/runs.py:RunService.list`

#### `POST /api/v1/projects/{projectId}/outline/{nodeId}/regenerate`

Re-runs the CLI with `--resume` against the project's last succeeded `full`/`regenerate_section` run's work directory, with only the target node's section deleted first so the CLI only regenerates that one leaf (`kind=regenerate_section`). Body: `promptModifier` (nullable — appended to the node's `summary` the worker sends the writer agent).

The node must already have a `cliKey` (i.e. was produced by a prior run). Before queuing, the current project/outline is re-rendered to the same spec text the base run would have produced and hashed; if that hash doesn't match what the base run actually saw (`structure_graph.json`'s `input_sha256`), the outline has drifted structurally since — the endpoint rejects with `409` rather than let a `--resume` desync from a `structure_graph.json` it can no longer trust.

Status codes: `202`; `404` if the project/node doesn't exist; `409` if the node has no `cliKey`, there's no resumable base run, or the outline has drifted since the base run; `422` on request validation.

Source: `api/application/runs.py:RunService.regenerate_node`, `api/application/runs.py:GenerationService._prepare_regenerate`

#### `GET /api/v1/runs/{runId}`

Status codes: `200`; `404`.

Source: `api/application/runs.py:RunService.get`

#### `POST /api/v1/runs/{runId}/cancel`

Sets `cancelRequested`; a `queued` run is cancelled immediately, a `running` one is asked to stop (the worker's drain loop polls `cancelRequested` and asks the CLI subprocess to terminate within `cli_cancel_grace_s`).

Status codes: `202`; `404`; `409` if the run is already terminal (`succeeded`/`failed`/`cancelled`).

Source: `api/application/runs.py:RunService.cancel`

#### `POST /api/v1/runs/{runId}/exports`

Re-runs the CLI with `--resume --export-tex-only` against a succeeded run's work directory, without touching any section, to (re)produce a LaTeX/PDF artifact in a different format (`kind=export`). Body: `format` (`latex|pdf`, required).

Status codes: `202`; `404` if the run doesn't exist; `409` if the base run didn't succeed, its work directory no longer exists (swept, `resumable=false`), or the project already has another active run.

Source: `api/application/runs.py:RunService.export`

#### `GET /api/v1/runs/{runId}/events`

Query: `afterSeq` (default 0 — only events with `seq > afterSeq`), `limit` (default 200, max 1000). Returns `Page<RunEvent>` (`offset` in the envelope echoes `afterSeq`, not a true offset). `RunEvent` fields: `seq`, `ts`, `level`, `stage`, `message`, `payload` (nullable, stage-specific).

Status codes: `200`; `404`.

Source: `api/application/runs.py:RunService.events`

#### `GET /api/v1/runs/{runId}/artifacts`

Query: `limit` (default 50, max 200), `offset` (default 0). Returns `Page<RunArtifact>`: `kind` (`markdown|tex|pdf|structure_graph|book_structure|section|section_review|kb_sources|run_meta|llm_usage|audit_report|log|bib|other`), `relativePath` (within the run's output directory), `fileId`/`filename`/`sizeBytes`/`contentType` (the uploaded object-storage `File`).

Status codes: `200`; `404`.

Source: `api/application/runs.py:RunService.artifacts`

#### `GET /api/v1/runs/{runId}/events/stream`

Server-Sent Events. `404`s upfront if the run doesn't exist, then polls for new events every second (`_SSE_POLL_INTERVAL_S`) and forwards each as an SSE message: `event` is `"section"`/`"done"` verbatim, `"log"` for an info-level log event, or `"stage"` for anything else; `id` is the event's `seq` (so a client reconnecting with `Last-Event-ID` resumes from `afterSeq=<that id>`); `data` is the `RunEvent` JSON. The stream closes itself once a `"done"` event is sent, or immediately if the client disconnects.

Status codes: `200` (stream); `404` before the stream opens if the run doesn't exist.

Source: `api/presentation/routers/runs.py:stream_run_events`

## Behind every run: how a project turns into CLI output

Not a route — context for reading the endpoints above. A `full` run renders the project + outline to the CLI's TXT/JSON spec (the same renderer `GET /projects/{id}/spec` exposes), writes it into a fresh work directory under `RUNS_DIR`, downloads the project's sources into a local KB directory, and invokes the CLI as a subprocess (`api/infrastructure/cli/book_command.py`, `subprocess_runner.py`), parsing its stdout into `RunEvent`s as it goes. On success, the CLI's `structure_graph.json` is imported back into outline nodes (`cliKey`, `contentMarkdown`/`contentLatex`, `status`, review fields — `api/application/graph_import.py`), and every file the CLI produced is uploaded to object storage as a `RunArtifact`. A `regenerate_section`/`export` run reuses that same work directory via `--resume` instead of starting over — see the endpoint descriptions above for what each does before invoking the CLI, and `api/application/runs.py:GenerationService` for the full execution path (this is what `worker/__main__.py` runs against real queued runs; `RunService` only ever queues them).
