/**
 * DTO aliases re-exported from the generated `schema.gen.ts` — nothing here
 * is hand-written, so these types can never drift from `docs/openapi.yaml`,
 * with two deliberate exceptions called out below (`Problem`, `Page<T>`).
 * Import from here (not `schema.gen.ts`) everywhere else in the app.
 */
import type { components, operations } from './schema.gen';

/**
 * RFC 9457 problem-details error body (`api/core/errors.py`'s
 * `_problem_response`). Hand-written: error responses come from exception
 * handlers, which FastAPI doesn't capture in the OpenAPI schema, so there is
 * no `components['schemas']` entry to point at.
 */
export interface Problem {
  type: string;
  title: string;
  status: number;
  instance: string;
  detail?: string | null;
}

/** Neither `/health` nor `/ready` declares a `response_model`, so these come from the untyped operation response rather than a named component — still codegen-backed, just not via `components['schemas']`. */
export type HealthStatus = operations['system-health']['responses'][200]['content']['application/json'];
export type ReadyStatus = operations['system-ready']['responses'][200]['content']['application/json'];

/**
 * Common page envelope (`{ items, total, limit, offset }`). The API used to
 * expose this as a single shared `PageBase` component; it now generates one
 * component per resource (`Page_File_`, `Page_Run_`, ...) since each is a
 * distinct instantiation of the backend's generic `Page[T]`. They're all
 * still structurally identical, so this stays a hand-written structural type
 * rather than re-exporting each one individually.
 */
export type Page<T> = { items: T[]; total: number; limit: number; offset: number };

export type FileKind = components['schemas']['FileKind'];
/** Named `FileDto`, not `File` — that would shadow the DOM `File` type used for actual upload blobs. */
export type FileDto = components['schemas']['File'];

/** Renamed `TargetAudience` in the API; kept as `AudienceLevel` here to avoid churning every consumer. */
export type AudienceLevel = components['schemas']['TargetAudience'];
export type OutputFormat = components['schemas']['OutputFormat'];
export type Project = components['schemas']['Project'];
export type ProjectSummary = components['schemas']['ProjectSummary'];
export type ProjectCreate = components['schemas']['ProjectCreate'];
export type ProjectUpdate = components['schemas']['ProjectUpdate'];

/** `GET /system/models`'s response — the models the configured LLM endpoint offers. */
export type ModelInfo = components['schemas']['ModelInfo'];
export type ModelList = components['schemas']['ModelList'];

export type SourceType = components['schemas']['SourceType'];
export type SourceStatus = components['schemas']['SourceStatus'];
export type Source = components['schemas']['Source'];
export type SourceCreate = components['schemas']['SourceCreate'];
export type SourceUpdate = components['schemas']['SourceUpdate'];

export type NodeStatus = components['schemas']['NodeStatus'];
export type MathLevel = components['schemas']['MathLevel'];
export type OutlineNode = components['schemas']['OutlineNode'];
export type OutlineNodeTree = components['schemas']['OutlineNodeTree'];
export type OutlineNodeCreate = components['schemas']['OutlineNodeCreate'];
export type OutlineNodeUpdate = components['schemas']['OutlineNodeUpdate'];
export type OutlineTreeReplaceNode = components['schemas']['OutlineTreeReplaceNode'];
/** `PUT /outline`'s body is a bare array now — the old wrapper object is gone. */
export type OutlineTreeReplace = components['schemas']['OutlineTreeReplaceNode'][];

export type RunKind = components['schemas']['RunKind'];
export type RunStatus = components['schemas']['RunStatus'];
/** Inlined identically on both `RunOptionsIn`/`RunOptionsOut` now; no shared component. */
export type AuditMode = components['schemas']['RunOptionsOut']['auditBookMode'];
/** Request body of `POST /projects/{id}/runs` — every field optional, server applies defaults. */
export type RunOptionsIn = components['schemas']['RunOptionsIn'];
/** `Run.options` as returned by every response — all fields populated except `promptModifier`. */
export type RunOptionsOut = components['schemas']['RunOptionsOut'];
export type Run = components['schemas']['Run'];
export type RunEvent = components['schemas']['RunEvent'];
/** `GET /runs/{id}/events`'s envelope — pages by `afterSeq` cursor, not `offset` like `Page<T>`. */
export type RunEventPage = components['schemas']['RunEventPage'];
export type ArtifactKind = components['schemas']['ArtifactKind'];
export type RunArtifact = components['schemas']['RunArtifact'];
export type RegenerateRequest = components['schemas']['RegenerateRequestIn'];
export type ExportFormat = components['schemas']['ExportRequestIn']['format'];
export type ExportRequest = components['schemas']['ExportRequestIn'];

/** The signed-in user, as returned by `POST /auth/login` and `GET /auth/me`. */
export type AuthUser = components['schemas']['UserOut'];
export type LoginRequest = components['schemas']['LoginRequest'];
