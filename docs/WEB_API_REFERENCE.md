# Web API Reference (HTTP/REST)

This document describes the HTTP API exposed by the FastAPI service in `api/` (`api/main.py:create_app`), reached through the nginx-fronted Docker Compose stack at `/api/...` (`docker-compose.yml`, `app/nginx.conf.template`). A machine-readable companion spec lives at `openapi.yaml` in this same directory.

This is a different document from [`API_REFERENCE.md`](API_REFERENCE.md), which covers the Python **CLI** (`main.py:parse_args`) — the two do not overlap.

## Status

Every endpoint below is implemented in `api/` today and has request/response coverage in `tests/api/` (some cross-cutting concerns — `Last-Event-ID` resume semantics on the SSE stream, the `worker` process itself, and the real MinIO/S3 adapter behind the storage interface — are exercised only indirectly or with fakes, not end-to-end). `docs/openapi.yaml` is a **generated artifact** (`scripts/export_openapi.py`, dumping `api.main:create_app().openapi()`) — regenerate it after any router/schema change instead of hand-editing it; this file carries the request/response prose and design notes the raw schema doesn't.

## Transport & deployment notes

- nginx (`app/nginx.conf.template`) only reverse-proxies `location /api/` to `http://api:8000` (the FastAPI container). Hashed `/assets/*` files are served immutable (a missing one is a `404`); everything else falls through to the SPA (`try_files ... /index.html`, served `Cache-Control: no-cache`).
- Every API response carries `Cache-Control: no-store` unless the route set its own policy (`api/core/cache_headers.py:NoStoreMiddleware`), alongside the `X-Request-Id` echo: API responses are never to be answered from a browser cache.
- Every versioned route is mounted under `/api/v1` (`api/main.py:create_app`, `APIRouter(prefix="/api/v1")`). Unversioned `/api/health` and `/api/ready` aliases also exist (`include_in_schema=False`, kept only for the Compose healthcheck) but are not part of the documented contract.
- FastAPI's auto-generated `/docs` (Swagger UI), `/redoc`, and `/openapi.json` are enabled in-process but served at unprefixed paths, so they are **not reachable** through the nginx-proxied public URL — only routes under `/api/...` are forwarded. To browse the spec, use `openapi.yaml` in this directory (e.g. load it into a local Swagger UI/Redoc instance), or hit the `api` container directly during local development.
- Every `/api/v1` route requires a valid session cookie except `POST /auth/login`, `GET /health`, and `GET /ready` (see **Authentication** below) — enforced as a router-level dependency (`api/main.py`'s `guarded_router`) and checked structurally by a route-walk test (`tests/api/test_auth.py`) so a newly added route is guarded by default. There is still no CORS middleware; the frontend and API are always same-origin (nginx/Vite proxy), so none is needed. `ProjectRecord.owner_id` / `RunRecord.started_by` are set from the authenticated user on create (`ownerId`/`ownerName`, `startedById`/`startedByName` in responses) — `null` on a project/run predating this or whose user account was later removed.
- The `api` container is reachable only from other containers on the Compose `frontend`/`backend` networks (`docker-compose.yml`); it has no published host port. `web` (nginx) is the only container exposed to the host, on `${WEB_PORT:-8080}`.
- Error responses use RFC 9457 problem details, `Content-Type: application/problem+json`, body `{type, title, status, detail?, instance}` (`api/core/errors.py`). `NotFound`→404, `Conflict`→409, `ValidationFailed`/request validation→422, `PayloadTooLarge`→413, `StorageError`→503, anything unexpected→500.
- List endpoints return `{items, total, limit, offset}` (`api/presentation/schemas/common.py:Page`); `limit` defaults to 50 and is capped at 200 unless a route documents a different default/cap below.
- All request/response bodies are camelCase on the wire, snake_case in Python (`api/presentation/schemas/common.py:BaseSchema`, `alias_generator=to_camel`).

## Authentication

Email + password login issuing a JWT in an httpOnly, `SameSite=Lax` session cookie (`AUTH_COOKIE_NAME`, default `autogenbook_session`; `AUTH_TOKEN_TTL_H`, default 24). No self-service signup or password reset — accounts are managed with `python -m api.scripts.users` (`create`/`set-password`/`activate`/`deactivate`/`list`). Every active user can see and do everything; there are no roles. `set-password` bumps `password_changed_at`, which invalidates every token issued before that moment on its next request (the only revocation story this needs, with 4 trusted users). Non-GET/HEAD/OPTIONS requests additionally require header `X-Requested-With: XMLHttpRequest` or get a `403`; a custom header can't be sent cross-origin without a CORS preflight, and this API has no CORS middleware, so a foreign `<form>` POST relying on the ambient cookie can never carry it.

#### `POST /api/v1/auth/login`

No auth required (this is the one route that must work with no session). Body `{email, password}`.

| Field | Type | Description |
| --- | --- | --- |
| `id` | `uuid` | |
| `email` | `string` | |
| `displayName` | `string` | |

Status codes:
- `200` — sets the session cookie, body is the user above.
- `401` — wrong password, unknown email, or a deactivated account; body is always the same generic `"Invalid email or password"` detail so a caller can't enumerate which of the 4 accounts exist.

Source: `api/presentation/routers/auth.py:login`, `api/application/auth.py:AuthService`

#### `POST /api/v1/auth/logout`

No path/query/body. Clears the session cookie.

Status codes: `204` always (idempotent even with no active session).

Source: `api/presentation/routers/auth.py:logout`

#### `GET /api/v1/auth/me`

No path/query/body. Returns the caller's own account.

| Field | Type | Description |
| --- | --- | --- |
| `id` | `uuid` | |
| `email` | `string` | |
| `displayName` | `string` | |
| `llmKeyConfigurable` | `boolean` | Per-user LLM key: whether the deployment can store personal keys (`LLM_KEY_ENCRYPTION_KEY` set). |
| `llmKeyPolicy` | `"optional" \| "required"` | `LLM_KEY_POLICY`: whether a run needs the user's own key. |
| `llmKey` | `{last4, updatedAt} \| null` | The user's stored key as the API reveals it: its last four characters and when it was set. The key and its ciphertext are never returned. |

Status codes:
- `200` — body is the user above.
- `401` — missing, expired, or invalidated (post `set-password`) session; header `WWW-Authenticate: Cookie`.

Source: `api/presentation/routers/auth.py:me`

#### `PUT /api/v1/auth/me/llm-key`

Body (`SetLlmKeyRequest`, `extra="forbid"`): `apiKey` (string; trimmed, must be non-blank, at most 512 characters). Stores it Fernet-encrypted as the caller's own LLM key (replacing any previous one); their runs then use it instead of the shared key.

Status codes: `200` — the updated user (as `GET /auth/me`); `401`; `409` code `llm_key_disabled` if the deployment has no `LLM_KEY_ENCRYPTION_KEY`; `422` for a blank/too-long key (the error never echoes the value). The body is never logged (`RequestIdMiddleware` logs only method, path and status).

Source: `api/presentation/routers/auth.py:set_llm_key`, `api/application/auth.py:AuthService.set_llm_key`

#### `DELETE /api/v1/auth/me/llm-key`

Clears the caller's stored key (works even when the feature is disabled, so leftovers can be removed). Status codes: `204`; `401`.

Source: `api/presentation/routers/auth.py:clear_llm_key`

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

#### `GET /api/v1/system/models`

Auth required (unlike `health`/`ready` above — this reaches out to the deployment's own configured LLM endpoint on every cache miss). No path/query/body. Queries `GET {baseUrl}/models` on the OpenAI-compatible endpoint the CLI itself would use (`AUTOGENBOOK_LLM_BASE_URL`, then `OPENROUTER_BASE_URL`, then OpenRouter's own default; API key from `AUTOGENBOOK_LLM_API_KEY` then `OPENROUTER_API_KEY`), and returns its model ids/names for the project-settings/start-run pickers. The result is cached in-process for ~5 minutes (`CachingModelCatalog`) so opening either dialog repeatedly doesn't re-hit the network every time; a failed fetch is never cached, so the next call retries immediately.

| Field | Type | Description |
| --- | --- | --- |
| `items` | `{id: string, name: string \| null}[]` | The endpoint's own model ids (what `llmModel` actually stores) and, where the endpoint returns one, a human-readable name. |
| `warning` | `string \| null` | Set (with `items: []`) when the endpoint couldn't be reached, returned an error, or an unexpected response shape — never a 5xx. |

Status codes: `200` always (network/HTTP/parse failures degrade to `{items: [], warning: "..."}` rather than an error status).

Source: `api/application/system.py:SystemService`, `api/infrastructure/llm/model_catalog.py`, `api/presentation/routers/system.py:list_models`

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

`llmModel` (issue #128) is on `ProjectCreate`/`ProjectUpdate` as an optional string, but always a concrete, non-null string on `Project` (not on `ProjectSummary`): `ProjectCreate.llmModel` omitted/null is resolved once, at creation, to `AUTOGENBOOK_LLM_MODEL` (or `openai/gpt-5-mini` if that's also unset) - the env var is never consulted again for that project afterward. `POST /projects/{id}/duplicate` copies the source project's `llmModel` verbatim rather than re-resolving the deployment default. See `GET /system/models` below for the model picker's data source, and `POST /projects/{id}/runs`'s `llmModel` for the per-run override.

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

Soft delete (see above). The source's id is also removed from every outline node's `sourceIds`; a node left with none falls back to `sourceScope: inherit` (issue #138).

Status codes: `204`; `404`.

Source (all five): `api/application/sources.py:SourceService`, `api/presentation/routers/sources.py`

## Outline

Outline nodes, mounted under `/api/v1/projects/{projectId}/outline`. The **flat** shape (`parentId` + `orderIndex`) is canonical; `?format=tree` (nested `children`) is a rendering convenience derived from it on every read. `level`, `sectionNumber`, and `cliKey` are always server-derived from the current tree shape (`api/domain/outline.py:assign_positions`) — never client-supplied. Deletes are soft (`deletedAt` set on the whole subtree via `delete_subtree`); reads only ever see live rows.

`OutlineNode` fields: `id`, `parentId`, `orderIndex`, `cliKey` (nullable — set once a run's CLI graph is imported back), `title`, `summary`, `level`, `sectionNumber`, `status` (`not_started|drafting|review_ready|compiled`), `targetPages`, `wordBudget` (`= 350 × targetPages` when not explicit), `actualWords` (word count of `contentMarkdown`, recomputed server-side whenever it changes), `equationDensityLevel` (1–5), `mathLevel` (`introductory|rigorous|formal_proof|applied`), `subPrompt`, `contentMarkdown`/`contentLatex`, `ragCitations`, `reviewerScore`/`reviewerNotes`, `structureLocked`, `contentLocked` (issue #113 — keep this leaf's `contentMarkdown` as-is across full runs while still feeding it into the cross-section context; only a leaf with non-blank content can be locked), `sourceScope` (`inherit|all|selected`, issue #138 — which project sources this node's sections retrieve from; `inherit` uses the nearest ancestor's scope, i.e. all sources at the top level), `sourceIds` (non-empty only when `sourceScope` is `selected`), timestamps.

#### `GET /api/v1/projects/{projectId}/outline`

Query: `format` (`flat` default | `tree`), `limit` (default 1000, max 5000 — a whole outline is read/edited as one unit, unlike files/projects there's no natural page size), `offset` (default 0). Returns `Page<OutlineNode>` or `Page<OutlineNodeTree>`.

Status codes: `200`; `404` if the project doesn't exist.

#### `PUT /api/v1/projects/{projectId}/outline`

Full-tree replace: body is `OutlineTreeReplaceNode[]` (nested, no ids — ids are minted on write), replacing every existing node. Enforces `project.maxOutlineLevels`. Returns the new flat `Page<OutlineNode>` (`limit=offset=` sized to the result, not paginated).

Status codes: `200`; `404`; `422` if the tree would exceed `maxOutlineLevels`.

#### `POST /api/v1/projects/{projectId}/outline`

Creates one node. Body: `parentId` (nullable), `title`, `orderIndex` (nullable — appended after existing siblings when omitted), `summary`, `targetPages`, `subPrompt`, `mathLevel` (default `rigorous`), `equationDensityLevel` (defaults to the project's `equationFrequencyLevel`).

Status codes: `201`; `404` if the project or `parentId` doesn't exist; `409` if `parentId` is a content-locked node (issue #113 — a lock only means something on a leaf; unlock it first); `422` if the new depth would exceed `maxOutlineLevels`.

#### `GET /api/v1/projects/{projectId}/outline/{nodeId}`

Status codes: `200`; `404` if the project or node doesn't exist.

#### `PATCH /api/v1/projects/{projectId}/outline/{nodeId}`

Partial update (`extra="forbid"` — `level`/`sectionNumber`/`cliKey`/`actualWords` are server-derived and rejected with `422` if sent, as is any other unknown key). Sending `parentId` and/or `orderIndex` re-parents/reorders the node (and re-sequences old and new sibling lists); moving a node into its own subtree, or to a depth that would exceed `maxOutlineLevels`, is rejected. `sourceScope`/`sourceIds` (issue #138): setting `sourceScope` to `inherit`/`all` clears `sourceIds`; `selected` requires at least one id of a live source of this project (duplicates are dropped, order kept); sending only `sourceIds` implies `selected`. Unlike structural edits, a scope change is allowed while a run is active — it takes effect on the next run, regenerate, or retry (`GenerationService` syncs current scopes into a reused `structure_graph.json`). The CLI receives them as `kb_scope`/`kb_sources` (`kb_sources` = source ids, i.e. the `kb/<sourceId>/` directories) in `book_structure.json`.

`contentLocked` (issue #113): `true` marks the leaf as content-locked — the next full run ships its `contentMarkdown` into the work dir (`out/locked_sections/<nodeId>.md`, referenced from `book_structure.json` as `content_locked`/`content_file`) and the CLI keeps it byte-for-byte instead of re-writing it, while still folding it into `context_memory.json`/`previous_sections` so later sections stop re-covering it; `graph_import` never overwrites a locked node's content on the way back. Setting it to `true` is rejected with `422` when `contentMarkdown` is blank and with `409` when the node has children (the CLI only writes section files for leaves); `null` leaves it unchanged. A `contentMarkdown` write that blanks a locked node clears the lock in the same write rather than failing a debounced autosave. Editing a locked node's text is allowed — the edited text is what the next run sees. A lock toggle is allowed while a run is active (it applies from the next run) and is deliberately *not* part of the spec the regenerate drift check hashes, so toggling it never invalidates `--resume`/regenerate.

A `contentMarkdown` write also re-anchors the node's margin cards (see **Comments**) in the same transaction, and takes the node row lock first (`SELECT ... FOR UPDATE`, the same order `POST /suggestions/{id}/accept` uses), so a save cannot interleave with an accept.

**A PATCH without `expectedContentHash` is last-write-wins**: it overwrites whatever text is stored, including text an accepted suggestion or a run just wrote. Clients must send `expectedContentHash` on every autosave of `contentMarkdown` and on every accept. `contentMarkdown: null` is `422` (send `""` to clear a section).

`expectedContentHash` (optional, 64 lowercase hex characters, else `422`): the `contentHash` of the text the edit was based on. When `contentMarkdown` is being written and the stored text hashes differently the write is refused with `409` `code: "content_conflict"` and the problem body carries `currentContentHash`; nothing is written. Checked whenever `contentMarkdown` is part of the request, even if the new text is identical; ignored otherwise. Clients should flush their autosave, then save with the hash they last received, and reload on `content_conflict`.

`contentHash` (issue #182): every **single-node** response (`GET .../outline/{nodeId}`, `PATCH`, and the `node` of `POST /suggestions/{id}/accept`) carries `contentHash`, the sha256 hex of the UTF-8 `contentMarkdown` - the same hashing as a suggestion's `baseContentHash`. It is computed on demand (not stored) and is `null` in lists, trees, create/replace/unlock responses, so a list costs no hash per node.

Status codes: `200`; `404` if the project/node/new-parent doesn't exist; `409` if `contentLocked: true` targets a node with children, or if `parentId` moves the node under a content-locked node; `422` on the validation cases above.

#### `POST /api/v1/projects/{projectId}/outline/unlock-all`

Clears `contentLocked` on every node of the project in one `UPDATE` (issue #113's "Unlock all", the way to get a clean-slate full run — a normal run always honours locks; there is no "ignore locks" run kind). Idempotent; content itself is untouched. Returns the whole flat outline as `Page<OutlineNode>` (sized to the result, like `PUT /outline`).

Status codes: `200`; `404` if the project doesn't exist.

#### `DELETE /api/v1/projects/{projectId}/outline/{nodeId}`

Soft-deletes the node and its entire subtree.

Status codes: `204`; `404`.

Source (all seven): `api/application/outline.py:OutlineService`, `api/domain/outline.py`, `api/presentation/routers/outline.py`

Every `OutlineNode` (flat, tree, single, create/update/replace responses, and the outline embedded in `Project`) also carries two derived badge counts (issue #182), computed from `node_comments` with one grouped query per request: `openCommentCount` (root `comment` threads whose status is `open` or `orphaned`, i.e. not resolved) and `pendingSuggestionCount` (`suggestion` rows that are `running` or `pending`). Soft-deleted rows are never counted. Reviewer issues (`kind=review`) are in neither count.

Every `OutlineNode` also carries `reviewSummary` (read-only, nullable): the section's latest reviewer verdict written by the graph import, `{okToKeep: bool, issueCount: int, suggestedEdits: string[], retrievalQueries: string[], runId: string|null, reviewedAt: ISO string}`; `null` = never reviewed. It is replaced wholesale by every new review of the node (it is a property of the latest review, with no card lifecycle) and is where the frontend reads the per-section verdict; the individual issues are `kind=review` cards.

## Comments

Margin cards of an outline node (issue #182): human comments and replies, reviewer issues (`kind=review`, see **Reviewer issues**) and AI suggestions (`kind=suggestion`, see **Revisions and suggestions**), all in table `node_comments` (soft delete via `deletedAt`, never exposed). Behind the session guard like every route; like the rest of the API any signed-in user can read and comment on any project. Rows of a soft-deleted node or project are never listed and their `/comments/{id}` routes 404. Replacing the outline (`PUT /outline`, or a run that generates one) soft-deletes the old nodes, so their comments are stranded along with their content.

`Comment`: `id`, `projectId`, `nodeId`, `kind` (`comment|suggestion|review`), `authorId` (nullable: copilot/reviewer), `authorName` (nullable, the author's current display name), `anchor` (nullable = the whole section), `status`, `threadId` (the root row's id; a root's own id), `parentId` (nullable; always the thread root's id), `bodyMarkdown`, `payload` (object; review/suggestion fields, `{}` for comments), `createdAt`, `updatedAt` (moves on any change), `editedAt` (nullable; set only by a body edit).

Statuses (a DB CHECK enforces the kind/status pairing): comment and review rows use `open | resolved | orphaned` (`orphaned` = the anchor's quote cannot be found any more; a resolved row stays `resolved`). Suggestion rows use `running` (job in flight, cancellable), `pending` (finished, awaiting accept/reject), `accepted`, `rejected`, `failed`, `cancelled`.

**Threads are flat.** A reply's `parentId` and `threadId` are both the root's id, even when it answers another reply. A reply stores no anchor or status of its own: responses show the root's `anchor` and `status`. Replying to a resolved thread reopens it (`open`, or `orphaned` if its anchor has null offsets). Replies are allowed under `comment` and `review` roots, `409` under a suggestion. Lists return whole threads (root plus all live replies, oldest first); the `kind`/`status` filters select **threads**: `kind` matches a thread whose root or any live row is of that kind (a copilot suggestion may sit inside the comment thread that prompted it), `status` then matches rows of that kind, or the root's own status when no `kind` is given. Lists are ordered by root `createdAt` (then id), with each thread's rows contiguous, oldest first.

`anchor` is a W3C text-quote selector over the node's `contentMarkdown`: `{quote, prefix, suffix, start, end}`. `start`/`end` are offsets in **Unicode code points** (Python `str` indices; not JS UTF-16 units), `end` exclusive, both `null` = orphaned; `prefix`/`suffix` are up to 32 code points of context (default `""`). Request validation (`422`): non-empty `quote`, `start`/`end` both set or both null, `end - start == len(quote)`, no extra keys. Responses are not re-validated with these rules (a stored anchor always serialises; a fuzzy re-anchor rewrites `quote` to the text actually matched). The server resolves every anchor with the engine's resolver (`engine/util/anchors.py`, ENGINE_REWRITE.md 4.9; `api/application/comment_anchors.py:resolve_anchor`): the client's offsets are a hint, kept only if the quote still sits there (and is unique or its `prefix`/`suffix` agree), else an exact match, a whitespace-/NFC-normalised match, or a bounded fuzzy match near the stored offset is used; anything ambiguous is orphaned (`start`/`end` stored `null`, status `orphaned`) - a false-positive match is worse than an orphan. A found anchor's `quote` is the text actually matched and `prefix`/`suffix` are refreshed from the content.

**Re-anchoring.** Whenever a node's `contentMarkdown` changes, one function (`api/application/reanchor.py:reanchor_node_cards`) re-resolves every live anchored card of that node against the new text, in the same transaction as the content write, with one query for the cards and one bulk write for the changed ones (the CPU work runs in a thread for big inputs). It is called from every content writer: the `PATCH .../outline/{nodeId}` content write, the graph import (`_merge_cli_graph_into_outline`, `import_single_node`, i.e. full runs, resumes and regenerate runs), and `POST /suggestions/{id}/accept`. Cards covered: root `comment` and `review` rows with an anchor (any status), and `suggestion` rows that are `running` or `pending`. The anchor moves with the text; for comment and review rows the status follows (`open` <-> `orphaned`; a `resolved` row stays `resolved`, an `orphaned` one whose quote reappears is `open` again). A pending suggestion keeps its status whatever happens to its text (it is never rewritten or dropped); accepting it re-validates it against the current text.

Limits (`422`): `bodyMarkdown` 1-20 000 characters and non-blank, anchor `quote` 1-20 000 characters; NUL (`\u0000`) is rejected in `bodyMarkdown` and in the anchor's `quote`/`prefix`/`suffix`.

#### `GET /api/v1/comments/{commentId}`

One live card with its full payload (a suggestion's `originalMarkdown`/`replacementMarkdown` included), as presented in lists (a reply shows its root's anchor/status). `404` for an unknown, deleted or deleted-node card.

#### `GET /api/v1/projects/{projectId}/outline/{nodeId}/comments`

Query: `kind`, `status` (optional, select threads, see below). Returns the node's whole threads as `Page<Comment>`, not paged (`total` counts thread roots; `limit` echoes the number of rows returned). `404` for an unknown project or node.

#### `GET /api/v1/projects/{projectId}/comments`

Same for all live nodes of the project, used for the margin and badges. To keep it small a suggestion's payload here leaves out the heavy texts `originalMarkdown` and `replacementMarkdown` (everything else, hunks included, is there); `GET /comments/{id}` carries them, and so does the node list - except for finished suggestions (`accepted|rejected|failed|cancelled`), whose full texts are dropped there too (hunks, summary and the rest stay); `running`/`pending` ones keep everything in the node list. Query: `kind`, `status`, `limit` (default 1000, max 5000, like the outline list) and `offset`; they page the matching thread **roots**, `total` counts roots, and each returned root's replies come along.

#### `POST /api/v1/projects/{projectId}/outline/{nodeId}/comments`

Body: `bodyMarkdown` (required), `anchor` (optional), `parentId` (optional, makes it a reply to that row's thread). Creates a `kind=comment` row authored by the caller, `201` with the `Comment`. An `anchor` sent with a reply is ignored. `404` if `parentId` is not a live row of this node (or its thread was deleted meanwhile), `409` under a suggestion.

#### `PATCH /api/v1/comments/{commentId}`

Body: `bodyMarkdown`. Author only (`403` otherwise, also for suggestion/review rows); sets `editedAt`; returns the `Comment`.

#### `DELETE /api/v1/comments/{commentId}`

Soft delete, `204`. Author only (`403`); rows with no author (reviewer cards) can be dismissed by any signed-in user. Deleting a `running` suggestion also stops its job (the owning process notices within a second). Deleting a thread root soft-deletes the whole thread (including other users' replies); deleting a reply only that reply.

#### `POST /api/v1/comments/{commentId}/resolve`

Body (optional): `{"resolved": true|false}`, default `true`. `true` sets the thread root's status to `resolved`; `false` reopens it (`open`, or `orphaned` if its anchor is unresolved). Any signed-in user may resolve - this is how a reviewer card is dismissed (a review row has no author; a dismissed issue is not re-created by a later import). `409` for a reply and for a suggestion row.

Outline badges: `openCommentCount` counts root `comment` rows that are `open` or `orphaned`; `pendingSuggestionCount` counts `suggestion` rows (root or not) that are `running` or `pending`.

Source: `api/application/comments.py:CommentService`, `api/application/reanchor.py`, `api/infrastructure/db/comment_repository.py`, `api/presentation/routers/comments.py`

### Reviewer issues (`kind=review`)

The graph import (`api/application/review_import.py`, called from `graph_import.py` for every imported leaf: full runs, resumes, regenerate runs, `outline: generate` runs) turns each issue of the engine's `section_reviews/<key>_revised.json` (else `<key>.json`) into one `kind=review` row: `authorId`/`authorName` null, `threadId = id`, `bodyMarkdown` = the issue's `description`, status `open` (`orphaned` if its quote cannot be found), `anchor` = the issue's `quote` resolved against the imported `contentMarkdown` (the engine's offsets are used when they still index the quote, else the quote is re-resolved tolerantly with `engine.util.anchors.resolve_quote`; `null` for a whole-section issue). `payload`:

| key | meaning |
|---|---|
| `issueKey` | stable identity, `sha256(type, quote, description)[:32]` |
| `type` | the reviewer's issue type (`coverage`, `terminology`, `consistency:term`, ...) |
| `severity` | `"major"` or `"minor"` (the engine's alias table; `critical` and its aliases fold into `major`) |
| `requiredFix` | what to change |
| `replaceFrom`, `replaceTo` | optional literal replacement inside the quote (`""` when none) |
| `quote` | the matched quote (`""` = whole section) |
| `okToKeep` | the section review's own verdict (the same on every issue of the section) |
| `source` | `"reviewer"` (the LLM reviewer), `"consistency"` (type `consistency:*`, the cross-section pass) or `"citation"` (the engine's removed-unknown-citations note) |
| `runId` | the run that produced it (string or `null`) |
| `outdated` | `true` only on a row a newer review no longer reports but a user had replied to (kept as resolved history) |
| `superseded` | `true` only on a soft-deleted row a newer review replaced (never returned by the API) |

The section verdict (`okToKeep`, `suggestedEdits`, `retrievalQueries`) is **not** a card: it is `OutlineNode.reviewSummary` (see **Outline**). `reviewerNotes` is still filled as before (the legacy Review tab).

**Idempotency.** Importing the same run again, a later run, a regenerate of one node and a resume never duplicate cards: issues are matched to the node's existing rows by `issueKey`. A known issue keeps its row with replies and state (only the anchor, payload and open/orphaned state are refreshed; `resolved` stays `resolved`); a new issue becomes a new row; an issue a user resolved or deleted does not come back; a row whose issue the new review no longer reports is soft-deleted (`superseded`) if it is open and untouched, kept `resolved` + `outdated` if it has replies, and left alone if it is resolved. A review file without issues clears the open untouched rows; a node without a review file keeps its cards. Replacing the outline (`PUT /outline`, `outline: generate` run) strands the old cards with the old nodes as before. Review rows are not counted in `openCommentCount`.

### Revisions and suggestions

The copilot (issue #182 phase 4). A *revision* asks the model to rewrite a section or a selected range; it is a `kind=suggestion` card: `running` while the job works, then `pending` (a diff awaiting accept/reject) or `failed`/`cancelled`; accepting writes the node's text (`accepted`), rejecting keeps it (`rejected`). It runs **in the API process** through `engine.revise` (one shared `ReviseClientPool`), needs no run and no work directory, and works on a project that never had one. The model is the project's `llmModel`, the endpoint the deployment's (`AUTOGENBOOK_LLM_BASE_URL`/`OPENROUTER_BASE_URL`), the key the caller's own LLM key when stored (policy `required` makes it mandatory, `409 llm_key_required`) else the deployment key - the same resolution runs use, including the environment's `AUTOGENBOOK_LLM_REASONING_EFFORT`, with an interactive timeout (90 s per request, one retry). Retrieval uses the knowledge base index of the project's most recent succeeded full/regenerate run (export runs are skipped), unless the saved index file is larger than `REVISION_MAX_KB_BYTES` (256 MB; the API pod is small): then the revision runs without retrieval and its `payload.warnings` says `sources too large to search during a revision`. The index is that of (`<workDir>/out/.kb_cache`, work dir from the database and required to lie under `RUNS_DIR`), restricted to the node's effective source scope; with no such run the model works from the section alone.

#### `POST /api/v1/projects/{projectId}/outline/{nodeId}/revisions`

Body (`extra="forbid"`):

```json
{
  "verb": "revise",                // "revise" (default) | "rewrite"
  "scope": "section",              // "section" (default) | "range"
  "anchor": { "quote": "...", "prefix": "", "suffix": "", "start": 12, "end": 40 },  // scope "range"; optional with threadId
  "instruction": "Add a short proof.",   // free text, <= REVISION_MAX_INSTRUCTION_CHARS (4000)
  "params": { "moreProofs": false, "moreExamples": false, "moreRigorous": false,
              "shorter": false, "longer": false, "citeSources": false,
              "fixIssueIds": [], "addressCommentIds": [] },   // <= 25 ids each
  "threadId": null                 // create the suggestion inside this comment/review thread
}
```

`202` with a discriminated body:

* `verb: "revise"` -> `{"kind": "suggestion", "suggestion": <Comment>}` - the new card, `status: "running"`, `authorId` = the caller, `anchor` = the resolved range (`null` for section scope), `threadId`/`parentId` = the thread root's id when `threadId` was given (else its own id / `null`), `payload` = the request echo (below).
* `verb: "rewrite"` -> `{"kind": "run", "runId": "...", "run": <Run>}`: Rewrite stays on the regenerate run - the call is `RunService.regenerate_node` with the instruction as `promptModifier`, with exactly that endpoint's `404`/`409` reasons (no previous run, content-locked node, regenerate already queued, ...). `REVISION_MAX_INSTRUCTION_CHARS` applies to it as well. Only `instruction` is allowed with it (`422` for a `range` scope, an anchor, any param or a `threadId`).

Validation (`422` unless noted): `shorter` and `longer` together; nothing to do (no instruction, no param, no `threadId`); instruction too long; `fixIssueIds` must be `kind=review` roots and `addressCommentIds` `kind=comment` roots **of this node**, `threadId` a comment/review root of this node (the thread's text is passed to the model as a comment to address, a review thread as an issue to fix, and the thread is settled on accept); a `range` needs an anchor (the request's or the thread's); an anchor with `scope: "section"`. `409` with `code`: `section_too_large` (scope `section` on a body longer than `REVISION_MAX_SECTION_CHARS`, 60 000 - the message suggests selecting a passage; range scope is still allowed), `section_empty` (nothing to revise), `node_generating` (a run is generating the node), `anchor_orphaned` (the range no longer matches the section at the stored/exact/whitespace level - select it again), `revision_in_progress` (a revision of this node is already running; also what the loser of two simultaneous starts gets), `llm_key_required`, `llm_not_configured` (no key for an OpenRouter endpoint). `429 too_many_revisions`: the caller already has `REVISION_MAX_PER_USER` (3) revisions running (admission is serialised per user, so simultaneous starts cannot exceed it). `404` unknown project/node.

**Suggestion payload** (`Comment.payload` of a `kind=suggestion` row; keys are camelCase):

| key | when | meaning |
|---|---|---|
| `verb`, `scope`, `instruction`, `params` | always | the request echo (`params` exactly as sent plus the defaults, ids as strings) - "try again" is a new POST with the same values |
| `threadId` | always | the thread root's id or `null` |
| `baseContentHash` | always | sha256 hex of the node's `contentMarkdown` the job started from |
| `model`, `startedAt` | always | model id; ISO time |
| `originalMarkdown`, `replacementMarkdown` | `pending`/`accepted`/`rejected` | the section body the job saw and the full new body (heavy: not in the project-wide list) |
| `hunks` | same | `[{start, end, removed, added}]`: offsets (Unicode code points) into `originalMarkdown`, `original[start:end] == removed`; applying them reproduces `replacementMarkdown` |
| `anchor` | same | the range as resolved in `originalMarkdown` (`null` for section scope) |
| `summary`, `changesMade[]`, `warnings[]`, `droppedCitations[]` | same | what the model says it did; engine warnings; citation keys it invented and the engine removed |
| `usage` | `pending`, `failed`, `cancelled` | LLM usage totals (tokens, cost when known); kept on failures; recorded here only (runs account cost on the run row, there is no project-level ledger) |
| `finishedAt` | terminal | ISO time |
| `error` | `failed` | `{code, message}`, see below |
| `acceptedAt`, `acceptedBy`, `appliedHunks` | `accepted` | `appliedHunks` is the list of hunk indexes applied, or `null` for all |
| `rejectedAt`, `rejectedBy` / `cancelledBy` | `rejected` / `cancelled` | |

`bodyMarkdown` of a pending suggestion is the model's summary (empty while running and on failure). `error.code` / problem `code` additions in this round: `content_conflict` (PATCH node, accept; carries `currentContentHash`), `section_too_large` (start). `error.code`: `llm_auth` (provider rejected the key), `llm_rate_limited`, `llm_timeout`, `llm_error` (any other provider failure), `llm_config`, `unusable_output` (the model's answer did not parse, even after a repair), `anchor_orphaned`, `revision_failed` (the engine refused the answer, e.g. it echoed the surrounding text; `message` explains), `invalid_request`, `timeout` (the job exceeded `REVISION_TIMEOUT_S`), `interrupted` (the API process died or restarted), `internal`. Messages are fixed user-facing texts - provider error text, URLs and keys never reach them.

#### `GET /api/v1/suggestions/{suggestionId}/events/stream`

Server-Sent Events of a revision; same conventions as the run stream: `id` is the event's `seq` (resume with `Last-Event-ID`), keep-alive pings every 15 s, the stream ends by itself after the terminal event, `404` before opening for an unknown/deleted/non-suggestion id. It only reads the database, so it works on any API replica and survives reconnects (progress events are persisted). Events:

* `event: progress`, `data: {seq, ts, stage, level, message, payload}`: the engine's stages `retrieve` (`payload.phase` `start`/`done`), `revise` (`start`, `model`, `done`, plus warnings such as throttling), `diff` (`start`/`done`, `payload.hunks`).
* exactly one terminal event, then the stream closes: `done` (the suggestion left `running`: `pending`, or already `accepted`/`rejected`), `failed` or `cancelled`; `data: {status, suggestion: <Comment, full payload>}`; its `id` is the last progress `seq` + 1.

#### `POST /api/v1/suggestions/{suggestionId}/accept`

Optional body `{"hunkIndexes": [0, 2], "expectedContentHash": "<64 hex>"}`. `hunkIndexes` (section scope only) applies just those hunks and must be unique, in range and non-empty (`422` otherwise); a partial accept does **not** settle the addressed threads/issues - only an accept of all hunks does. `expectedContentHash` is the `contentHash` of the section text the client shows (flush autosave first): `409 content_conflict` (with `currentContentHash`) if the stored text differs. `200` `{"suggestion": <Comment, accepted>, "node": <OutlineNode>}`. Only a `pending` suggestion (`409 not_pending`; the suggestion is re-read under the node lock, so the loser of two simultaneous accepts gets `not_pending`). One transaction, with the node row locked: the node's `contentMarkdown` is written (`actualWords` updated, and - like a content `PATCH` - a locked node whose text becomes blank is unlocked), the suggestion becomes `accepted`, the thread it lives in, the review rows in `fixIssueIds` and the comment threads in `addressCommentIds` become `resolved`, and the node's other cards are re-anchored. If the text changed since `baseContentHash` the suggestion is applied to the *current* text or refused, never merged blindly (`api/application/revision_apply.py`): a **range** suggestion re-resolves its anchor (which only follows text that is still unchanged: re-anchoring never fuzzily follows an edit of a suggestion's range, it orphans the anchor instead) and splices the new range text there if it is found at the stored/exact/whitespace level, **is demonstrably the selected copy** (the anchor's stored context agrees at that place, or the quote was unique when the suggestion was made - `payload.anchorUnique` - and still occurs exactly once; another copy of a repeated quote never qualifies), **and** the text now at the range is *exactly* the range text the model was given, with unchanged word characters just outside it - an edit inside the range, a paragraph break in it, or an edit glued to its boundary is the user's work and gives `stale`; a **section** suggestion needs every selected hunk's window (32 characters of original context, the `removed` text, 32 characters of context; for a pure insertion the seam between the two contexts) to occur **exactly once** in the current text, and the places not to overlap - no nearest-offset guessing, so repetitive text (identical list rows) is `stale`. Otherwise `409 stale` (nothing changes; the user asks again). Other `409` codes: `node_generating` (a regenerate run owns the node), `run_active` (a full run is queued/running and would overwrite an unlocked node), `invalid_suggestion`. A `contentLocked` node is accepted like a content `PATCH` is allowed (the lock protects against runs). `422` for `hunkIndexes` that are empty or sent for a range suggestion. `404` unless a live suggestion.

#### `POST /api/v1/suggestions/{suggestionId}/reject`

`pending` -> `rejected`, `200` with the `Comment`; `409 not_pending` otherwise.

#### `POST /api/v1/suggestions/{suggestionId}/cancel`

`running` -> `cancelled`, `200` with the `Comment`. Author only (`403`), idempotent for a `cancelled` one, `409 not_running` for the other states and when the job recorded its result first (a finished result wins the race). Works from any replica (below).

**Pending suggestions and text that moved.** Cards follow the text: the anchor of a `running`/`pending` suggestion is re-anchored together with the other cards - but only when its quote is found unchanged (stored/exact/whitespace); otherwise its anchor is orphaned (`start`/`end` null, quote kept) - the status is never touched, and nothing is rewritten. The consequences are decided at accept time (above). There is no automatic "stale" flag; `baseContentHash` is there for clients that want one.

**Jobs, replicas and restarts.** A job is an asyncio task in one API process (its owner); everything other replicas need is in the database. State changes are compare-and-set on the suggestion row (`UPDATE ... WHERE status = <expected>`), so cancel, finish, accept, reject and crash recovery cannot clobber each other (the loser of a race gets a `409`/is a no-op). `revision_jobs` holds the owner id, a heartbeat (every `REVISION_HEARTBEAT_S`, 10 s; compared against the database clock) and a cancel flag; `revision_events` the progress events. The job row is deleted when the suggestion leaves `running`, its events are purged by the sweep `REVISION_EVENTS_KEEP_S` (5 min) after that - a reconnecting client of an old suggestion just gets the terminal event. Cancel on a replica that does not own the task flips the row; the owner polls its row every second, sees the status change (or a deleted row) and cancels its task; the owner itself stops at once and records the usage. At most one revision runs per node (unique partial index) and `REVISION_MAX_PER_USER` per user. Each job has an overall limit `REVISION_TIMEOUT_S` (300 s). On startup the process fails the `running` suggestions an earlier process of the same host left (`interrupted`); every replica also sweeps for `running` suggestions whose heartbeat is older than `REVISION_STALE_S` (45 s) and fails them the same way; on shutdown the jobs are cancelled and their suggestions become `interrupted`. Limits: a job dies with its process (the user retries), a process frozen for longer than `REVISION_STALE_S` gets its job failed although it might still finish (its late result is discarded), a job whose card, node or project is deleted stops within a second and its card ends `cancelled` (usage kept).

Source: `api/application/revisions.py` (`RevisionService`, `RevisionRunner`), `api/application/revision_apply.py`, `api/infrastructure/db/revision_repository.py`, `api/presentation/routers/revisions.py`

## Runs

Generation runs: driving the CLI as a subprocess, streaming its progress, and syncing its output back into outline nodes/files. `RunService` (API-side: create/list/get/cancel/export/regenerate/retry/events) is called from the routers below; `GenerationService` (worker-side, `api/worker/__main__.py`) is a separate process that actually claims queued runs and executes them — the two never run in the same process.

`Run` fields: `id`, `projectId`, `kind` (`full|regenerate_section|export`), `status` (`queued|running|succeeded|failed|cancelled`), `options` (the request options echoed back, plus `promptModifier` for a `regenerate_section` run, and `llmModel` — issue #128, always a concrete model id: resolved at creation from the request's own `llmModel` else the project's, and backfilled from the project/deployment default on read for a run row that predates this field), `baseRunId`/`targetNodeId` (nullable — set for `regenerate_section`/`export`, and for a `full` run created by `POST /runs/{id}/retry` (issue #124)), `exitCode`, `error` (a user-facing message: for an LLM endpoint failure the worker rewrites the CLI's raw exception text into `Generation with model <options.llmModel> failed: <reason>. <hint>.` naming the run's own model - a blocked/unknown model, rejected key, insufficient credits, rate limit, server error or unreachable endpoint each get their own reason and hint via `api/application/run_errors.py:describe_cli_failure`; any other failure keeps the CLI's own text, and a run killed by `CLI_RUN_TIMEOUT_S` reports `killed by API after <n>s timeout`), `errorDetail` (nullable - the CLI's original error text when `error` was rewritten from it, `null` when `error` *is* the original text; the run detail page shows it collapsed under `error` as "Original error", the failure toast shows `error` only and tells the user to check the run details), `totalTokens`/`totalCostUsd` (nullable, summed from the CLI's `run_meta.json`), `queuedAt`/`startedAt`/`finishedAt`, `resumable` (`false` once the run's work directory has been swept, `RUNS_RETENTION_DAYS` after it finished — a swept run can no longer be the base of a `regenerate`/`export`/`retry`), `retryable` (`true` iff `POST /runs/{id}/retry` would pass its *intrinsic* preconditions on this run: `kind == full`, `status` in `{failed, cancelled}`, and its work directory plus `structure_graph.json` both still on disk — computed by the same `retry_blocker` helper the endpoint itself validates with, so the two can never drift apart; deliberately excludes the endpoint's other, transient 409 guards — a full run already queued/running, the project's queue being full, outline drift, a succeeded sibling on the same work directory), `queuePosition` (nullable int, issue #134 — 1-based position among the project's other `queued` runs; `null` once the run is `running` or terminal).

**Run queue (issue #134):** a project may hold **one `running` run** plus up to `MAX_QUEUED_RUNS_PER_PROJECT` (default 5, env `MAX_QUEUED_RUNS_PER_PROJECT`) **`queued`** runs at once — queueing several runs no longer requires waiting for each to finish first. Admission is decided by `queue_admission_blocker(blocked_by_full_run, laneRuns, cap)` (`api/application/runs.py`), called by every endpoint that queues a new run:

| New run | Blocked by | Result |
|---|---|---|
| `full` from `create` | nothing but the cap | `202` queued behind anything already in the lane |
| `regenerate_section` / `export` / `retry` | a `full` run already `queued` or `running` for the project (a queued `retry` counts too — it's itself `kind=full`) | `409` ("a full run is queued or running…") |
| `regenerate_section` / `export` / `retry` | only `regenerate_section`/`export`/`retry` runs ahead of it | `202` queued — executes sequentially against the shared work directory |
| `regenerate_section` | this node already has a `queued`/`running` regenerate (`status=drafting`) | `409` ("already has a regenerate queued or running…") |
| any kind | the project's lane already has `cap` `queued` runs | `409` ("project's run queue is full…") |

`regenerate_section`/`export`/`retry` are blocked by a queued/running `full` run (not the reverse) because all three resume a fixed base work directory and (for `regenerate_section`/`retry`) `project.lastRunId`, either of which a `full` run starting later would rewrite out from under them — `retry` itself creates a `kind=full` row, but unlike `create`'s run it resumes an existing `work_dir` (`options.resume=true`), so it's admitted the same way `regenerate_section`/`export` are, not the way `create` is. Only `create`'s `full` run reads the project/outline fresh when it starts, so it alone is exempt from the "blocked by a full run" rule and only has to respect the cap. Admission for one project is serialized across concurrent requests (a Postgres advisory lock held for the rest of the request's transaction) so two racing requests can't both read an under-cap/empty lane and both get admitted. `GET /projects/{projectId}/runs`'s `status` query param (below) is the way to fetch just a project's current lane (`queued`+`running`) instead of paging through its whole history.

The outline structural-edit guard (`OutlineService._reject_if_run_active`) and `DELETE /projects/{projectId}` are unchanged: both still `409` while the project has *any* `queued` or `running` run, not just a `running` one — a structural edit or project delete is unsafe for a run that hasn't started yet either.

#### `POST /api/v1/projects/{projectId}/runs`

Body (`RunOptionsIn`, `extra="forbid"`): `outline` (`project` default — use the project's own outline | `generate` — let the CLI structure it), `outputFormat` (nullable — defaults to the project's own `outputFormat`), `allowSubdivision` (default `true`), `enableWebRag`, `auditBook`, `auditBookMode` (`off|warn|strict`, default `warn`), `legacyTex`, `rebuildKb`, `failFastSchema`, `resume`, `exportTexOnly` (booleans, default `false` unless noted), `unlockAll` (boolean, default `false`, issue #113 — clear every content lock of the project as part of queueing this run, only after every validation/admission check has passed, so a rejected request never leaves the project unlocked with no run; not a run option and not echoed back on `Run.options`), `llmModel` (nullable string, issue #128 — omitted/null uses the project's own `llmModel`; the resolved value is what `Run.options.llmModel` echoes back and what the worker sets `AUTOGENBOOK_LLM_MODEL` to for the CLI subprocess).

`legacyTex` and `auditBook` both require the resolved `outputFormat` (the explicit body value, or the project's own if omitted) to be `latex` or `pdf` — with `markdown`, `legacyTex` would otherwise "succeed" with no document assembled at all, and `auditBook` would silently be a no-op (both need a `tex_path` the markdown-only assembly path never produces).

`legacyTex` is also rejected when `outline` is `project` and any outline node is `contentLocked` (issue #113) unless `unlockAll` is set: the legacy path generates LaTeX, and a locked section's text is Markdown. Locked sections otherwise always apply to a `project`-outline full run — their text is written to `out/locked_sections/<nodeId>.md` in the run's own work dir (so locks keep working after older work dirs are swept) and referenced from `book_structure.json`; `generate` sends no outline, so locks are inapplicable there.

Status codes: `202`; `404` if the project doesn't exist; `409` if the project's queue is full (`MAX_QUEUED_RUNS_PER_PROJECT` queued runs already) or, under `LLM_KEY_POLICY=required`, if the starting user has no stored LLM key (problem body carries `code: "llm_key_required"`; `regenerate`, `retry` and `export` apply the same rule - `queue_admission_blocker`'s `llm_key_missing`); `422` if `legacyTex` or `auditBook` is combined with a `markdown` output format, or `legacyTex` with a content-locked node.

Source: `api/application/runs.py:RunService.create`

#### `GET /api/v1/projects/{projectId}/runs`

Query: `status` (repeatable, e.g. `?status=queued&status=running` — omit for full history), `limit` (default 50, max 200), `offset` (default 0). Returns `Page<Run>`.

Status codes: `200`; `404` if the project doesn't exist.

Source: `api/application/runs.py:RunService.list`

#### `POST /api/v1/projects/{projectId}/outline/{nodeId}/regenerate`

Re-runs the CLI with `--resume` against the project's last succeeded `full`/`regenerate_section` run's work directory, with only the target node's section deleted first so the CLI only regenerates that one leaf (`kind=regenerate_section`). Body: `promptModifier` (nullable — appended to the node's `summary` the worker sends the writer agent).

The node must already have a `cliKey` (i.e. was produced by a prior run). Before queuing, the current project/outline is re-rendered to the same spec text the base run would have produced and hashed; if that hash doesn't match what the base run actually saw (`structure_graph.json`'s `input_sha256`), the outline has drifted structurally since — the endpoint rejects with `409` rather than let a `--resume` desync from a `structure_graph.json` it can no longer trust.

A `contentLocked` node is rejected with `409` ("unlock it first"): regenerating deletes `sections/<cliKey>.md`, which is precisely what the lock exists to prevent. Because a regenerate (and a retry) reuses the base run's `structure_graph.json`, the worker first syncs the outline's *current* locks into it (`sync_content_locks_into_graph`, the lock-side twin of the kb-scope sync): a node unlocked since the base run loses its stale `content_locked`/`content_file` and is generated, a node locked or edited-while-locked since gets its current text written to `out/locked_sections/`, and the CLI's `--resume` skips the context bookkeeping for a locked leaf whose kept text is already in `sections/`. Toggling `contentLocked` on any node is *not* outline drift — the flag is deliberately absent from the rendered spec the drift check hashes — so a lock toggle alone never turns a later regenerate into a `409`.

Status codes: `202`; `404` if the project/node doesn't exist; `409` if the node already has a `regenerate` queued/running (`status=drafting`), a `full` run is already queued/running for the project, the project's queue is full, the node has no `cliKey`, the node is `contentLocked`, there's no resumable base run, or the outline has drifted since the base run; `422` on request validation.

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

Status codes: `202`; `404` if the run doesn't exist; `409` if the base run didn't succeed, its work directory no longer exists (swept, `resumable=false`), a `full` run is already queued/running for the project, or the project's queue is full.

Source: `api/application/runs.py:RunService.export`

#### `POST /api/v1/runs/{runId}/retry`

Resumes a `failed`/`cancelled` `full` run from its own work directory (issue #124): creates a new `full` run, `options.resume=True`, sharing the old run's work directory (`baseRunId` pointing at the run being resumed) — the same `regenerate`/`export` pattern of a new row over the old one's directory, scoped to `full` runs only (a `regenerate_section`/`export` run is already re-triggerable by clicking the same action again). No request body. The old run's row is left completely untouched — it stays the historical record of that attempt, and `project.lastRunId` is not touched until the new run actually succeeds.

Guards, in order (all `409` unless noted): `kind != full`; `status` not in `{failed, cancelled}`; the work directory or its `structure_graph.json` is missing (both surfaced up front as `retryable=false`, see above); a `full` run is already queued/running for the project, or the project's queue is full (retry itself creates a `kind=full` run, but — like `regenerate`/`export`, not `create` — it resumes a fixed existing `work_dir`, so it's blocked by another queued/running `full` run the same way they are, on top of respecting the cap); the current project/outline, re-rendered and hashed the same way `regenerate`'s drift check works, no longer matches the `input_sha256` the failed run's `structure_graph.json` recorded (catches an edit made between the failure and the retry — the CLI's own `--resume` short-circuit would otherwise silently start over from scratch at full cost instead of erroring); another run already sharing this work directory has `status=succeeded` (nothing left to resume). The worker itself re-checks the work directory/graph exist right before it starts the CLI subprocess, closing the window where the retention sweep removes the directory between queuing and claiming.

Status codes: `202`; `404` if the run doesn't exist; `409` per the guards above.

Source: `api/application/runs.py:RunService.retry`, `api/application/runs.py:retry_blocker`

#### `GET /api/v1/runs/{runId}/events`

Query: `afterSeq` (default 0 — only events with `seq > afterSeq`), `limit` (default 200, max 1000). Returns `Page<RunEvent>` (`offset` in the envelope echoes `afterSeq`, not a true offset). `RunEvent` fields: `seq`, `ts`, `level`, `stage`, `message`, `payload` (nullable, stage-specific).

Status codes: `200`; `404`.

Source: `api/application/runs.py:RunService.events`

#### `GET /api/v1/runs/{runId}/artifacts`

Query: `kind` (optional; one of `markdown|tex|pdf|structure_graph|book_structure|section|section_review|kb_sources|run_meta|llm_usage|audit_report|log|bib|other` — restricts the page to that `ArtifactKind` only), `limit` (default 50, max 200), `offset` (default 0). Returns `Page<RunArtifact>`: `kind`, `relativePath` (within the run's output directory), `fileId`/`filename`/`sizeBytes`/`contentType` (the uploaded object-storage `File`).

Artifacts appear here incrementally while the run is still `running`, not only once it reaches a terminal status (issue #129): the worker's drain loop uploads each leaf's `sections/<key>.md` (and `section_reviews/<key>.json`, if produced) as soon as the CLI announces that section, ahead of the terminal `upload_artifacts` call that covers everything else (`markdown`/`tex`/`pdf`/`bib`/`log`/... and any section the incremental path missed, e.g. because the run was cancelled mid-upload). Without `?kind=`, results are ordered by `relativePath`, which sorts `section_reviews/*` ahead of `sections/*` — on a run with enough leaf sections, an unfiltered `limit: 200` page can fill up with reviews before every section is listed; use `?kind=section` (or the summary endpoint below) to fetch a kind's own full set instead of racing every other kind for the same page.

Status codes: `200`; `404`.

Source: `api/application/runs.py:RunService.artifacts`

#### `GET /api/v1/runs/{runId}/artifacts/summary`

Returns `{ countsByKind: { [kind: string]: number } }` — every `ArtifactKind` this run has at least one artifact for, with its total count. Lets a client (the "N of M sections generated" counter, `ArtifactsList`'s per-kind fetches) know each kind's size without paging through `GET /runs/{runId}/artifacts` to count it.

Status codes: `200`; `404`.

Source: `api/application/runs.py:RunService.artifact_counts_by_kind`

#### `GET /api/v1/runs/{runId}/events/stream`

Server-Sent Events. `404`s upfront if the run doesn't exist, then polls for new events every second (`_SSE_POLL_INTERVAL_S`) and forwards each as an SSE message: `event` is `"section"`/`"done"` verbatim, `"log"` for an info-level log event, or `"stage"` for anything else; `id` is the event's `seq` (so a client reconnecting with `Last-Event-ID` resumes from `afterSeq=<that id>`); `data` is the `RunEvent` JSON. The stream closes itself once a `"done"` event is sent, or immediately if the client disconnects.

Status codes: `200` (stream); `404` before the stream opens if the run doesn't exist.

Source: `api/presentation/routers/runs.py:stream_run_events`

## Behind every run: how a project turns into CLI output

Not a route — context for reading the endpoints above. A `full` run renders the project + outline to the CLI's TXT/JSON spec (the same renderer `GET /projects/{id}/spec` exposes), writes it into a fresh work directory under `RUNS_DIR`, downloads the project's sources into a local KB directory, and invokes the CLI as a subprocess (`api/infrastructure/cli/book_command.py`, `subprocess_runner.py`), parsing its stdout into `RunEvent`s as it goes. On success, the CLI's `structure_graph.json` is imported back into outline nodes (`cliKey`, `contentMarkdown`/`contentLatex`, `status`, review fields — `api/application/graph_import.py`), and every file the CLI produced is uploaded to object storage as a `RunArtifact`. A `regenerate_section`/`export` run reuses that same work directory via `--resume` instead of starting over — see the endpoint descriptions above for what each does before invoking the CLI, and `api/application/runs.py:GenerationService` for the full execution path (this is what `worker/__main__.py` runs against real queued runs; `RunService` only ever queues them).
