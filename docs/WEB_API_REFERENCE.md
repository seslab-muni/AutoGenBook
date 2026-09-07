# Web API Reference (HTTP/REST)

This document describes the HTTP API exposed by the FastAPI service in `api/` (`api/main.py`), reached through the nginx-fronted Docker Compose stack at `/api/...` (`docker-compose.yml`, `app/nginx.conf`). A machine-readable companion spec lives at `openapi.yaml` in this same directory.

This is a different document from [`API_REFERENCE.md`](API_REFERENCE.md), which covers the Python **CLI** (`main.py:parse_args`) — the two do not overlap.

## Status legend

- **Status: Implemented** — exists in `api/main.py` today, verified directly against the source.
- **Status: Planned — not yet implemented** — a proposed contract only, derived from the frontend's current data model (`app/src/types.ts`) and its mock handler functions (`app/src/App.tsx`). No route in this state exists in `api/` yet. It is intended as a stable target for both frontend and backend work, not a commitment to the exact final shape.

## Transport & deployment notes

- nginx (`app/nginx.conf`) only reverse-proxies `location /api/` to `http://api:8000` (the FastAPI container). Everything else falls through to the SPA (`try_files ... /index.html`).
- FastAPI's auto-generated `/docs` (Swagger UI), `/redoc`, and `/openapi.json` are enabled in-process (`api/main.py` does not set `docs_url=None` etc.) but are served at unprefixed paths, so they are **not reachable** through the nginx-proxied public URL — only routes under `/api/...` are forwarded. To browse the spec, use `openapi.yaml` in this directory (e.g. load it into a local Swagger UI/Redoc instance), or hit the `api` container directly during local development.
- No authentication and no CORS middleware exist anywhere in `api/main.py` today. This applies to both the implemented and planned sections below.
- The `api` container is reachable only from other containers on the Compose `frontend`/`backend` networks (`docker-compose.yml`); it has no published host port. `web` (nginx) is the only container exposed to the host, on `${WEB_PORT:-8080}`.

## Implemented (Today)

### System endpoints

#### `GET /api/health`

**Status: Implemented**

No path/query parameters, no request body, no auth.

| Field | Type | Description |
| --- | --- | --- |
| `status` | `string` | Always `"ok"`. |

Status codes: `200` always.

Source: `api/main.py:health`

#### `GET /api/ready`

**Status: Implemented**

No path/query parameters, no request body, no auth. Opens a fresh `psycopg` (v3) connection to Postgres (`DATABASE_URL` env var, 3s connect timeout) and runs `SELECT 1`.

| Field | Type | Description |
| --- | --- | --- |
| `status` | `string` | `"ready"` when the `SELECT 1` check succeeds. |

Status codes:
- `200` — DB check succeeded, body `{"status": "ready"}`.
- `500` — the DB connection/query raised (e.g. Postgres unreachable); there is no explicit `try`/`except`, so this is FastAPI's default unhandled-exception response, not a custom error body.

This is also the endpoint Docker Compose's healthcheck polls for the `api` service (`docker-compose.yml`).

Source: `api/main.py:ready`

## Planned (Draft — Not Yet Implemented)

Everything in this section is a **proposal**, derived directly from `app/src/types.ts` (the frontend's current TypeScript data model) and the handler functions in `app/src/App.tsx` (which today just mutate local React state — there is no real HTTP call anywhere in `app/src`). None of it exists in `api/` yet. Treat this as the contract to build the real backend against, and to build new frontend features against, so the two stay in sync as the backend gets implemented.

### Data model mapping

| TypeScript type (`app/src/types.ts`) | Proposed OpenAPI schema | Notes |
| --- | --- | --- |
| `BookProject` | `Project` (full) and `ProjectSummary` (list view) | `ProjectSummary` is new, not a 1:1 TS type — see "Projects" below for why. |
| `OutlineNode` | `OutlineNode` | Flattened: `children: OutlineNode[]` is dropped in favor of `parentId` + `orderIndex` — see "Outline representation" below. |
| `IngestedSource` | `Source` | Field set unchanged. |
| `RAGCitation` | `RAGCitation` | Unchanged. |
| `AgentStreamLog` | `AgentStreamLog` | Unchanged, used as the payload of SSE `log` events. |
| `StreamState` | *(no direct wire type)* | Superseded by a `GenerationRun` polling resource plus an SSE event stream — see "Streaming" below. |

### Design decisions

#### Outline representation: flat list with `parentId`, not a nested tree

`OutlineNode.children?: OutlineNode[]` in the frontend type is a nested tree, but the proposed API represents outline nodes as a **flat list with `parentId` and `orderIndex`** fields instead. This mirrors what the real document graph already does on disk: `autogenbook/graph/doc_graph.py` wraps an `networkx.DiGraph` (`DocGraph`) and persists it via `save_graph_json` as an ordered list of nodes plus an ordered list of `(parent, child)` edges — not a nested structure. Building the API on the same flat shape means the backend doesn't need to convert to/from a tree, and single-node mutations (rename, delete, edit content) become plain single-row operations instead of whole-subtree replacements — which is also what every `app/src/App.tsx` outline handler already does one node at a time (`handleAddChildNode`, `handleRenameNode`, `handleDeleteNode`, etc.), each currently reimplementing its own recursive tree walker just to touch one node.

Clients that want a tree for rendering can fold the flat list into one client-side (cheap, O(n)) — the same work `doc_graph.py` implicitly does when it walks the graph. For frontend convenience, `GET /api/projects/{projectId}/outline` also accepts `?format=tree` to get the nested shape directly from the server; the flat shape is the default and canonical representation.

#### Streaming: Server-Sent Events (SSE), not WebSocket

Generation progress (`AgentStreamLog` entries and token output, currently faked with a `setInterval` in `app/src/App.tsx`'s `handleTriggerNodeGeneration`) is proposed as **SSE**, not WebSocket, for two reasons:

1. **Infra fit**: `app/nginx.conf`'s `location /api/` block sets `proxy_http_version 1.1` and standard forwarding headers, but has no `Upgrade`/`Connection: upgrade` directives, which WebSocket requires. SSE works over plain HTTP/1.1 through the existing proxy configuration unchanged.
2. **Semantic fit**: the stream is server→client only (the client never sends data back over the same channel mid-generation), which is exactly what SSE is for.

A plain polling endpoint (`GET .../generate/{runId}`) is proposed alongside the stream as a fallback for clients that can't hold a long-lived connection, and because it maps directly onto the accumulated shape `StreamState` already has (`logs`, `tokenBuffer`).

### Projects

`BookProject` → `Project` (full resource) / `ProjectSummary` (list view — `WelcomeProjectsView` only ever reads `title`, `subtitle`, `authors`, `sources.length`, `updatedAt` etc. for its project cards, never the full outline, so the list endpoint returns a lighter shape).

```typescript
export interface BookProject {
  id: string;
  title: string;
  subtitle: string;
  authors: string[];
  topic: string;
  targetAudience: AudienceLevel;
  totalPagesBudget: number;
  equationFrequencyLevel: number; // 1 to 5
  doConsiderOutline: boolean;
  doConsiderPreviousSections: boolean;
  outputFormat: 'latex' | 'markdown' | 'pdf';
  maxOutlineLevels?: number; // 1 to 5, default 3
  sources: IngestedSource[];
  outline: OutlineNode[];
  createdAt: string;
  updatedAt: string;
}
```

| Method | Path | Request body | Response body | Status codes | Maps to |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/projects` | — | `ProjectSummary[]` | 200 | `WelcomeProjectsView`'s `books` prop / `app/src/data/sampleBooks.ts` |
| POST | `/api/projects` | `ProjectCreate` (= `Project` fields minus `id`/`createdAt`/`updatedAt`; `sources`/`outline` optional, default empty) | `Project` | 201 | `handleCreateNewBook(newBook: BookProject)` |
| GET | `/api/projects/{projectId}` | — | `Project` (full, including `sources` and `outline`) | 200, 404 | project navigation / `currentBook` |
| PATCH | `/api/projects/{projectId}` | `Partial<Project>` (metadata fields only — not `sources`/`outline`, which have their own endpoints) | `Project` | 200, 404 | `handleSaveProjectSettings(updated: Partial<BookProject>)` |
| POST | `/api/projects/{projectId}/duplicate` | — | `Project` (new project, cloned) | 201, 404 | `handleDuplicateProject(book)` |
| DELETE | `/api/projects/{projectId}` | — | — | 204, 404 | `handleDeleteProject(bookId)` |

`ProjectSummary` fields: `id`, `title`, `subtitle`, `authors`, `topic`, `targetAudience`, `totalPagesBudget`, `sourcesCount` (int, derived), `outlineNodeCount` (int, derived), `createdAt`, `updatedAt`.

### Sources

`IngestedSource` → `Source`, nested under a project.

```typescript
export type SourceType = 'pdf' | 'doc' | 'ppt' | 'md' | 'txt' | 'slides' | 'arxiv' | 'notes' | 'bibtex' | 'latex' | 'url' | 'book' | 'dataset';

export interface IngestedSource {
  id: string;
  name: string;
  size: string;
  type: SourceType;
  chunksCount: number;
  uploadDate: string;
  status: 'indexed' | 'indexing' | 'error';
  authors?: string;
  year?: string;
  doi?: string;
  url?: string;
  description?: string;
}
```

| Method | Path | Request body | Response body | Status codes | Maps to |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/projects/{projectId}/sources` | — | `Source[]` | 200, 404 | source list panel |
| POST | `/api/projects/{projectId}/sources` | `multipart/form-data` (file upload) **or** `application/json` `{ type: 'arxiv'\|'url'\|'bibtex', identifier?, url?, rawText?, description? }` for the non-file ingest tabs | `Source` with `status: 'indexing'` | 202, 404 | `handleAddSource(newSource: IngestedSource)` |
| GET | `/api/projects/{projectId}/sources/{sourceId}` | — | `Source` (for polling `status` until `'indexed'`/`'error'`) | 200, 404 | source status polling |
| DELETE | `/api/projects/{projectId}/sources/{sourceId}` | — | — | 204, 404 | `handleDeleteSource(sourceId)` |

Ingestion is proposed as asynchronous (`202`, `status: 'indexing'`) since `chunksCount`/`status` in the existing type already imply a background chunking/embedding step, not an instant operation.

### Outline nodes

`OutlineNode`, flattened per the "Outline representation" decision above, nested under a project.

```typescript
export type NodeStatus = 'not_started' | 'drafting' | 'review_ready' | 'compiled';

export interface OutlineNode {
  id: string;
  title: string;
  sectionNumber: string; // e.g. "1.2.1"
  level: number; // 1 = Chapter, 2 = Section, 3 = Subsection
  status: NodeStatus;
  targetPages: number;
  wordBudget: number;
  actualWords: number;
  equationDensityLevel: number; // 1 to 5
  mathLevel: 'introductory' | 'rigorous' | 'formal_proof' | 'applied';
  subPrompt?: string;
  contentMarkdown: string;
  contentLatex: string;
  ragCitations: RAGCitation[];
  reviewerScore?: number;
  reviewerNotes?: string;
}
```

Proposed API shape adds `parentId: string | null` and `orderIndex: number` in place of `children`.

| Method | Path | Request body | Response body | Status codes | Maps to |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/projects/{projectId}/outline` | — (optional query `?format=tree`) | `OutlineNode[]` flat (default), or nested tree if `format=tree` | 200, 404 | outline tree view |
| POST | `/api/projects/{projectId}/outline` | `{ parentId: string \| null, title: string, level: number, orderIndex?: number }` | `OutlineNode` (new) | 201, 404 | `handleAddChildNode(parentNodeId)` |
| GET | `/api/projects/{projectId}/outline/{nodeId}` | — | `OutlineNode` (full, including `contentMarkdown`/`contentLatex`/`ragCitations`) | 200, 404 | section editor view |
| PATCH | `/api/projects/{projectId}/outline/{nodeId}` | `Partial<OutlineNode>` | `OutlineNode` (updated) | 200, 404 | `handleRenameNode`, `handleUpdateContent`, `handleUpdateNodeMathLevel`, `handleUpdateNodeEquationDensity`, `handleUpdateNodeBudget` (consolidated — see note) |
| DELETE | `/api/projects/{projectId}/outline/{nodeId}` | — | — | 204, 404 | `handleDeleteNode(nodeId)` |

**Note on `PATCH`**: `app/src/App.tsx` has five separate handlers that each mutate one or two fields of the same `OutlineNode` (rename, content, math level, equation density, budget). The proposal deliberately consolidates all five into a single generic `PATCH` on the node resource, since they all target the same underlying record — this is a simplification, not a 1:1 handler mapping.

### Generation & streaming

`AgentStreamLog` / `StreamState` → a `GenerationRun` resource plus an SSE stream.

```typescript
export interface AgentStreamLog {
  id: string;
  timestamp: string;
  agentName: 'Planner Agent' | 'Writer Agent' | 'Math Formalizer' | 'Reviewer Agent' | 'RAG Retriever';
  agentColor: string;
  status: 'active' | 'completed' | 'queued' | 'error';
  thought: string;
  tokensGenerated?: number;
  currentStep: string;
}
```

| Method | Path | Request body | Response body | Status codes | Maps to |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/projects/{projectId}/generate` | `{ nodeId?: string, promptModifier?: string, scope: 'node' \| 'batch' }` | `{ runId: string, status: 'queued' }` | 202, 404 | `handleTriggerNodeGeneration(promptModifier?)` (`scope: 'node'`) and `TopHeader`'s `onStartBatchGeneration` (`scope: 'batch'`) |
| GET | `/api/projects/{projectId}/generate/{runId}` | — | `GenerationRun { id, status: 'queued'\|'running'\|'completed'\|'error', activeNodeId, startedAt, completedAt?, logs: AgentStreamLog[] }` | 200, 404 | polling fallback |
| GET | `/api/projects/{projectId}/generate/{runId}/stream` | — | `text/event-stream`: events `log` (`AgentStreamLog` JSON), `token` (partial content chunk), `done` (terminal) | 200 (stream stays open until the run finishes or the client disconnects) | live token/log streaming (replaces the `setInterval` fake stream) |

### Export

Maps to `ExportModal`'s format tabs and `BookProject.outputFormat`.

| Method | Path | Request body | Response body | Status codes | Maps to |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/projects/{projectId}/export` | `{ format: 'latex' \| 'markdown' \| 'bibtex' \| 'pdf' }` | Either the artifact directly (`Content-Type` per format: `text/plain`, `application/x-latex`, `application/pdf`) or `{ jobId: string }` for async formats | 200 (sync) or 202 (async), 404 | `ExportModal` |

PDF export is flagged as the likely-async case: the container installs `texlive-luatex` (`Dockerfile`) for real LuaLaTeX compilation, which is a non-trivial server-side operation, unlike the client-side `Blob`/`URL.createObjectURL` the current mock `ExportModal` fakes. Whether other formats are sync or async is left open — see "Open questions" below.

## Traceability appendix

| `App.tsx` handler / UI affordance | Proposed endpoint |
| --- | --- |
| `handleAddChildNode(parentNodeId)` | `POST /api/projects/{projectId}/outline` |
| `handleRenameNode(nodeId, newTitle)` | `PATCH /api/projects/{projectId}/outline/{nodeId}` |
| `handleDeleteNode(nodeId)` | `DELETE /api/projects/{projectId}/outline/{nodeId}` |
| `handleUpdateContent(nodeId, markdown, latex?)` | `PATCH /api/projects/{projectId}/outline/{nodeId}` |
| `handleTriggerNodeGeneration(promptModifier?)` | `POST /api/projects/{projectId}/generate` (`scope: 'node'`) |
| `handleUpdateNodeMathLevel(mathLevel)` | `PATCH /api/projects/{projectId}/outline/{nodeId}` |
| `handleUpdateNodeEquationDensity(density)` | `PATCH /api/projects/{projectId}/outline/{nodeId}` |
| `handleUpdateNodeBudget(targetPages, wordBudget)` | `PATCH /api/projects/{projectId}/outline/{nodeId}` |
| `handleCreateNewBook(newBook)` / `NewBookWizardModal.onCreateBook` | `POST /api/projects` |
| `handleDuplicateProject(book)` | `POST /api/projects/{projectId}/duplicate` |
| `handleDeleteProject(bookId)` | `DELETE /api/projects/{projectId}` |
| `handleSaveProjectSettings(updated)` | `PATCH /api/projects/{projectId}` |
| `handleAddSource(newSource)` | `POST /api/projects/{projectId}/sources` |
| `handleDeleteSource(sourceId)` | `DELETE /api/projects/{projectId}/sources/{sourceId}` |
| `WelcomeProjectsView` project list rendering | `GET /api/projects` |
| `TopHeader.onStartBatchGeneration` | `POST /api/projects/{projectId}/generate` (`scope: 'batch'`) |
| `ExportModal` download | `POST /api/projects/{projectId}/export` |

## Open questions / explicitly out of scope

- **Auth / multi-tenant model**: not designed here — the current app has no concept of users or accounts.
- **Pagination**: `GET /api/projects` and `GET /api/projects/{projectId}/sources` are shown without pagination params; add `limit`/`cursor` (or `page`/`page_size`) once real usage volumes are known.
- **Sync vs. async export**: whether `latex`/`markdown`/`bibtex` exports are synchronous (`200`) or job-based (`202` + polling, like `pdf`) is left open.
- **Cancelling a generation run**: no cancel/abort endpoint is proposed, because no such affordance exists in `app/src/App.tsx` or its child components today. This would be a genuinely new feature, not a documented mapping of an existing one — flagged here as speculative future work only.
