/**
 * DTO aliases re-exported from the generated `schema.gen.ts` — nothing here
 * is hand-written, so these types can never drift from `docs/openapi.yaml`.
 * Import from here (not `schema.gen.ts`) everywhere else in the app.
 */
import type { components } from './schema.gen';

export type Problem = components['schemas']['Problem'];
export type HealthStatus = components['schemas']['HealthStatus'];
export type ReadyStatus = components['schemas']['ReadyStatus'];

/** Common page envelope (`{ items, total, limit, offset }`); `PageOf*` schemas in the spec are this shape specialized per resource. */
export type Page<T> = components['schemas']['PageBase'] & { items: T[] };

export type FileKind = components['schemas']['FileKind'];
/** Named `FileDto`, not `File` — that would shadow the DOM `File` type used for actual upload blobs. */
export type FileDto = components['schemas']['File'];

export type AudienceLevel = components['schemas']['AudienceLevel'];
export type OutputFormat = components['schemas']['OutputFormat'];
export type Project = components['schemas']['Project'];
export type ProjectSummary = components['schemas']['ProjectSummary'];
export type ProjectCreate = components['schemas']['ProjectCreate'];
export type ProjectUpdate = components['schemas']['ProjectUpdate'];

export type SourceType = components['schemas']['SourceType'];
export type SourceStatus = components['schemas']['SourceStatus'];
export type RAGCitation = components['schemas']['RAGCitation'];
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
export type OutlineTreeReplace = components['schemas']['OutlineTreeReplace'];

export type RunKind = components['schemas']['RunKind'];
export type RunStatus = components['schemas']['RunStatus'];
export type AuditMode = components['schemas']['AuditMode'];
export type RunOptions = components['schemas']['RunOptions'];
export type Run = components['schemas']['Run'];
export type RunEvent = components['schemas']['RunEvent'];
export type ArtifactKind = components['schemas']['ArtifactKind'];
export type RunArtifact = components['schemas']['RunArtifact'];
export type RegenerateRequest = components['schemas']['RegenerateRequest'];
export type ExportFormat = components['schemas']['ExportFormat'];
export type ExportRequest = components['schemas']['ExportRequest'];

/** The signed-in user, as returned by `POST /auth/login` and `GET /auth/me`. */
export type AuthUser = components['schemas']['UserOut'];
export type LoginRequest = components['schemas']['LoginRequest'];
