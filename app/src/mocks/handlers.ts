import { http, HttpResponse, sse } from 'msw';

import { resolveAnchor } from '@/features/editor/lib/anchors';
import { claimNextQueued, driveFakeRun } from './fakeRun';
import { db, stripProjectId, type ProjectRow } from './db';
import { DEFAULT_MOCK_LLM_MODEL, MOCK_MODELS, MOCK_USER, MOCK_USER_PASSWORD } from './fixtures';
import { notFound, problemResponse } from './problem';
import type {
  Comment,
  CommentCreate,
  ExportRequest,
  FileDto,
  HealthStatus,
  LoginRequest,
  ModelList,
  OutlineNode,
  OutlineNodeCreate,
  OutlineNodeTree,
  OutlineNodeUpdate,
  OutlineTreeReplace,
  OutlineTreeReplaceNode,
  Page,
  Problem,
  ProjectCreate,
  ProjectUpdate,
  ReadyStatus,
  RegenerateRequest,
  Run,
  RunEvent,
  RunEventPage,
  RunOptionsIn,
  Source,
  SourceCreate,
  SourceType,
  SourceUpdate,
} from '@/api/types';

function paginate<T>(items: T[], url: URL): Page<T> {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 200);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0), 0);
  return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
}

/** `Settings.max_queued_runs_per_project`'s mock-side default (`api/core/settings.py`). */
const MAX_QUEUED_RUNS_PER_PROJECT = 5;

/** Every queued-or-running run for `projectId`, oldest first — `db.runs` (a `Map`) iterates in
 * insertion/creation order, which tracks `queuedAt` closely enough for the mock's own ordering
 * to never need a timestamp comparison (and the ties one risks under fast, synchronous test
 * `POST`s). Mirrors `RunRepository.list_active_for_project`. */
function laneRunsFor(projectId: string): Run[] {
  return [...db.runs.values()].filter(
    (run) => run.projectId === projectId && (run.status === 'queued' || run.status === 'running'),
  );
}

/** Mirrors `queue_admission_blocker` (`api/application/runs.py`, issue #134) so the mock's
 * admission rules can't drift from the real API's — the 409 reason a new run should be refused
 * given its project's current lane, or `null` if admission is allowed. `blockedByFullRun`: `true`
 * for `regenerate`/`export`/`retry` (relative to a fixed base work dir/`project.lastRunId` a
 * later `full` run would rewrite out from under them), `false` for `create`'s own `full` run
 * (always reads the project/outline fresh when it starts, so it's never blocked by the lane,
 * only the cap). */
function queueAdmissionBlocker(blockedByFullRun: boolean, lane: Run[]): string | null {
  if (blockedByFullRun && lane.some((run) => run.kind === 'full')) {
    return 'a full run is queued or running for this project; wait for it to finish or cancel it';
  }
  const queuedCount = lane.filter((run) => run.status === 'queued').length;
  if (queuedCount >= MAX_QUEUED_RUNS_PER_PROJECT) {
    return `project's run queue is full (${MAX_QUEUED_RUNS_PER_PROJECT} queued); wait for one to start or cancel one`;
  }
  return null;
}

/** 1-based position of `run` among its project's other `queued` runs, or `null` once it's
 * running/terminal — computed on read rather than stored, mirroring `RunRepository.queue_position`.
 * Every handler that returns a `Run` to the client goes through this. */
function withQueuePosition(run: Run): Run {
  if (run.status !== 'queued') return { ...run, queuePosition: null };
  const queuedIds = [...db.runs.values()]
    .filter((other) => other.projectId === run.projectId && other.status === 'queued')
    .map((other) => other.id);
  const position = queuedIds.indexOf(run.id);
  return { ...run, queuePosition: position === -1 ? null : position + 1 };
}

const EXTENSION_KB_ELIGIBLE = new Set(['pdf', 'docx', 'pptx', 'md', 'txt']);
const EXTENSION_SOURCE_TYPE: Record<string, SourceType> = {
  pdf: 'pdf',
  docx: 'doc',
  pptx: 'ppt',
  md: 'md',
  txt: 'txt',
};

function extensionOf(filename: string): string {
  return filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// system
// ---------------------------------------------------------------------------

const systemHandlers = [
  http.get('*/api/v1/health', () => HttpResponse.json({ status: 'ok' } satisfies HealthStatus)),
  http.get('*/api/v1/ready', () => HttpResponse.json({ status: 'ready' } satisfies ReadyStatus)),
  http.get('*/api/v1/system/models', () =>
    HttpResponse.json({ items: MOCK_MODELS, warning: null } satisfies ModelList),
  ),
];

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

/**
 * Mirrors `queue_admission_blocker`'s `llm_key_missing` rule: under policy `required` every
 * run-queuing endpoint (create, regenerate, retry, export) answers 409 `llm_key_required` for a
 * user without a stored key.
 */
function llmKeyRequiredProblem(request: Request) {
  if (db.llmKeyPolicy !== 'required' || db.llmKey) return null;
  return problemResponse(
    409,
    'Conflict',
    new URL(request.url).pathname,
    'This deployment requires your own LLM API key to start runs; set it in your account settings first',
    'llm_key_required',
  );
}

/**
 * MSW doesn't enforce the real httpOnly-cookie mechanism, so — like every other mock handler —
 * these default to "signed in as `MOCK_USER`" rather than actually tracking a session; a test
 * exercising logged-out behavior (`require-auth`, the 401 response middleware) overrides
 * `GET /auth/me` with `server.use(...)` to return a 401 instead.
 */
const authHandlers = [
  http.post('*/api/v1/auth/login', async ({ request }) => {
    const body = (await request.json()) as LoginRequest;
    if (body.email === MOCK_USER.email && body.password === MOCK_USER_PASSWORD) {
      return HttpResponse.json(MOCK_USER);
    }
    return problemResponse(401, 'Invalid email or password', new URL(request.url).pathname);
  }),

  http.get('*/api/v1/auth/me', () =>
    HttpResponse.json({
      ...MOCK_USER,
      llmKeyConfigurable: db.llmKeyConfigurable,
      llmKeyPolicy: db.llmKeyPolicy,
      llmKey: db.llmKey,
    }),
  ),

  // Per-user LLM key. Mirrors the real API: 409 `llm_key_disabled` when the deployment has no
  // encryption key, 422 for a blank key, and the response only ever carries the last four chars.
  http.put('*/api/v1/auth/me/llm-key', async ({ request }) => {
    const instance = new URL(request.url).pathname;
    if (!db.llmKeyConfigurable) {
      return problemResponse(
        409,
        'Conflict',
        instance,
        'per-user LLM keys are not enabled on this deployment (LLM_KEY_ENCRYPTION_KEY is not set)',
        'llm_key_disabled',
      );
    }
    const body = (await request.json()) as { apiKey: string };
    const key = body.apiKey.trim();
    if (!key) {
      return problemResponse(
        422,
        'Validation Failed',
        instance,
        'apiKey must not be empty or blank',
      );
    }
    if (key.length > 512) {
      return problemResponse(
        422,
        'Validation Failed',
        instance,
        'apiKey must be at most 512 characters',
      );
    }
    db.llmKey = { last4: key.slice(-4), updatedAt: db.now() };
    return HttpResponse.json({
      ...MOCK_USER,
      llmKeyConfigurable: db.llmKeyConfigurable,
      llmKeyPolicy: db.llmKeyPolicy,
      llmKey: db.llmKey,
    });
  }),

  http.delete('*/api/v1/auth/me/llm-key', () => {
    db.llmKey = null;
    return new HttpResponse(null, { status: 204 });
  }),

  http.post('*/api/v1/auth/logout', () => new HttpResponse(null, { status: 204 })),
];

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

const fileHandlers = [
  http.get('*/api/v1/files', ({ request }) => {
    const url = new URL(request.url);
    return HttpResponse.json(paginate([...db.files.values()], url));
  }),

  http.post('*/api/v1/files', async ({ request }) => {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) {
      return problemResponse(422, 'Missing "file" field', new URL(request.url).pathname);
    }
    const ext = extensionOf(file.name);
    const id = db.nextId();
    const dto: FileDto = {
      id,
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      sha256: id,
      kind: 'upload',
      kbEligible: EXTENSION_KB_ELIGIBLE.has(ext),
      createdAt: db.now(),
    };
    db.files.set(id, dto);
    return HttpResponse.json(dto, { status: 201 });
  }),

  http.get('*/api/v1/files/:fileId', ({ params, request }) => {
    const file = db.files.get(params.fileId as string);
    if (!file) return notFound('File', new URL(request.url).pathname);
    return HttpResponse.json(file);
  }),

  http.delete('*/api/v1/files/:fileId', ({ params, request }) => {
    const fileId = params.fileId as string;
    const file = db.files.get(fileId);
    if (!file) return notFound('File', new URL(request.url).pathname);
    const referenced =
      [...db.sources.values()].some((source) => source.fileId === fileId) ||
      [...db.runArtifacts.values()].some((artifacts) =>
        artifacts.some((artifact) => artifact.fileId === fileId),
      );
    if (referenced) {
      return problemResponse(409, 'File is still referenced', new URL(request.url).pathname);
    }
    db.files.delete(fileId);
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('*/api/v1/files/:fileId/content', ({ params, request }) => {
    const file = db.files.get(params.fileId as string);
    if (!file) return notFound('File', new URL(request.url).pathname);
    const body = new TextEncoder().encode(`Mock content for ${file.filename}`);
    return new HttpResponse(body, {
      headers: {
        'Content-Type': file.contentType,
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'Content-Length': String(body.byteLength),
        ETag: `"${file.sha256}"`,
      },
    });
  }),
];

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

function createProjectRow(body: ProjectCreate): ProjectRow {
  const id = db.nextId();
  const now = db.now();
  return {
    id,
    // MSW doesn't enforce the real auth mechanism, so every project created through the mock
    // API is attributed to `MOCK_USER` — the same "always signed in" assumption every other
    // handler makes.
    ownerId: MOCK_USER.id,
    ownerName: MOCK_USER.displayName,
    title: body.title,
    subtitle: body.subtitle,
    authors: body.authors,
    topic: body.topic,
    targetAudience: body.targetAudience ?? 'graduate',
    totalPagesBudget: body.totalPagesBudget ?? 350,
    equationFrequencyLevel: body.equationFrequencyLevel ?? 4,
    doConsiderOutline: body.doConsiderOutline ?? true,
    doConsiderPreviousSections: body.doConsiderPreviousSections ?? true,
    outputFormat: body.outputFormat ?? 'markdown',
    maxOutlineLevels: body.maxOutlineLevels ?? 3,
    additionalRequirements: body.additionalRequirements ?? null,
    llmModel: body.llmModel ?? DEFAULT_MOCK_LLM_MODEL,
    lastRunId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function insertOutlineTree(
  nodes: OutlineTreeReplace,
  projectId: string,
  parentId: string | null,
  depth: number,
  numberPrefix: string,
  cliPrefix: string,
  maxOutlineLevels: number,
): { error?: string } {
  if (depth > maxOutlineLevels) {
    return { error: `Outline depth exceeds maxOutlineLevels (${maxOutlineLevels})` };
  }
  for (const [index, node] of nodes.entries()) {
    const id = db.nextId();
    const sectionNumber = numberPrefix ? `${numberPrefix}.${index + 1}` : `${index + 1}`;
    const cliKey = cliPrefix ? `${cliPrefix}-${index + 1}` : `${index + 1}`;
    const now = db.now();
    const row: OutlineNode & { projectId: string } = {
      projectId,
      id,
      parentId,
      orderIndex: index,
      cliKey,
      title: node.title,
      summary: node.summary ?? '',
      level: depth,
      sectionNumber,
      status: 'not_started',
      targetPages: node.targetPages ?? 1,
      wordBudget: Math.round((node.targetPages ?? 1) * 350),
      actualWords: 0,
      equationDensityLevel: node.equationDensityLevel ?? 3,
      mathLevel: node.mathLevel ?? 'rigorous',
      subPrompt: node.subPrompt ?? null,
      contentMarkdown: '',
      contentLatex: '',
      ragCitations: [],
      reviewerScore: null,
      reviewerNotes: null,
      structureLocked: true,
      contentLocked: false,
      sourceScope: 'inherit',
      sourceIds: [],
      createdAt: now,
      updatedAt: now,
    };
    db.outlineNodes.set(id, row);
    if (node.children?.length) {
      const result = insertOutlineTree(
        node.children,
        projectId,
        id,
        depth + 1,
        sectionNumber,
        cliKey,
        maxOutlineLevels,
      );
      if (result.error) return result;
    }
  }
  return {};
}

/**
 * Mirrors `OutlineService.update`'s source-scope rules (issue #138): `inherit`/`all` clear
 * `sourceIds` (non-empty ids alongside them is a 422), `selected` needs at least one id of a live
 * source of the node's project (de-duplicated), and `sourceIds` sent alone implies `selected`.
 * Returns the node's (possibly unchanged) scope fields, or an error title for a 422.
 */
/** Mirrors `OutlineService._normalize_content_lock` (issue #113). */
function normalizeContentLock(
  node: OutlineNode & { projectId: string },
  body: OutlineNodeUpdate,
): { contentLocked: boolean } | { status: 409 | 422; error: string } {
  const content = body.contentMarkdown ?? node.contentMarkdown;
  const wantsLock = body.contentLocked ?? node.contentLocked;
  if (!wantsLock) return { contentLocked: false };
  if (content.trim().length === 0) {
    if (body.contentLocked != null) {
      return {
        status: 422,
        error: 'contentLocked requires the node to have content; write the section first',
      };
    }
    return { contentLocked: false };
  }
  if (
    body.contentLocked != null &&
    [...db.outlineNodes.values()].some((other) => other.parentId === node.id)
  ) {
    return {
      status: 409,
      error: `outline node ${node.id} has child sections; only a leaf's content can be locked`,
    };
  }
  return { contentLocked: true };
}

function normalizeSourceScope(
  node: OutlineNode & { projectId: string },
  body: OutlineNodeUpdate,
): Pick<OutlineNode, 'sourceScope' | 'sourceIds'> | { error: string } {
  const ids = body.sourceIds ?? undefined;
  const scope = body.sourceScope ?? (ids !== undefined ? 'selected' : undefined);
  if (scope === undefined) return { sourceScope: node.sourceScope, sourceIds: node.sourceIds };
  if (scope !== 'selected') {
    if (ids?.length) return { error: `sourceIds must be empty when sourceScope is "${scope}"` };
    return { sourceScope: scope, sourceIds: [] };
  }
  const unique = [...new Set(ids ?? [])];
  if (unique.length === 0) return { error: 'sourceScope "selected" needs at least one source' };
  const unknown = unique.filter((id) => db.sources.get(id)?.projectId !== node.projectId);
  if (unknown.length)
    return { error: `Unknown source ids for this project: ${unknown.join(', ')}` };
  return { sourceScope: 'selected', sourceIds: unique };
}

/** Detaching a source prunes it from every node's `sourceIds`; a node left empty falls back to `inherit`. */
function pruneSourceFromOutline(projectId: string, sourceId: string): void {
  for (const node of db.outlineNodes.values()) {
    if (node.projectId !== projectId || !node.sourceIds.includes(sourceId)) continue;
    const sourceIds = node.sourceIds.filter((id) => id !== sourceId);
    db.outlineNodes.set(node.id, {
      ...node,
      sourceIds,
      sourceScope: sourceIds.length > 0 ? node.sourceScope : 'inherit',
    });
  }
}

function deleteOutlineSubtree(nodeId: string): void {
  const children = [...db.outlineNodes.values()].filter((node) => node.parentId === nodeId);
  for (const child of children) {
    deleteOutlineSubtree(child.id);
  }
  db.outlineNodes.delete(nodeId);
}

function outlineDepthOf(nodeId: string | null): number {
  let depth = 0;
  let current = nodeId;
  while (current) {
    depth += 1;
    current = db.outlineNodes.get(current)?.parentId ?? null;
  }
  return depth;
}

const projectHandlers = [
  http.get('*/api/v1/projects', ({ request }) => {
    const url = new URL(request.url);
    return HttpResponse.json(paginate(db.listProjectSummaries(), url));
  }),

  http.post('*/api/v1/projects', async ({ request }) => {
    const body = (await request.json()) as ProjectCreate;
    const row = createProjectRow(body);
    db.projects.set(row.id, row);
    if (body.sources?.length) {
      for (const sourceCreate of body.sources) {
        attachSource(row.id, sourceCreate);
      }
    }
    if (body.outline?.length) {
      insertOutlineTree(body.outline, row.id, null, 1, '', '', row.maxOutlineLevels);
    }
    const project = db.getProject(row.id);
    return HttpResponse.json(project, { status: 201 });
  }),

  http.get('*/api/v1/projects/:projectId', ({ params, request }) => {
    const project = db.getProject(params.projectId as string);
    if (!project) return notFound('Project', new URL(request.url).pathname);
    return HttpResponse.json(project);
  }),

  http.patch('*/api/v1/projects/:projectId', async ({ params, request }) => {
    const projectId = params.projectId as string;
    const row = db.projects.get(projectId);
    if (!row) return notFound('Project', new URL(request.url).pathname);
    const body = (await request.json()) as ProjectUpdate & { sources?: unknown; outline?: unknown };
    if ('sources' in body || 'outline' in body) {
      return problemResponse(
        422,
        '"sources"/"outline" have their own endpoints',
        new URL(request.url).pathname,
      );
    }
    db.projects.set(projectId, {
      ...row,
      ...body,
      title: body.title ?? row.title,
      subtitle: body.subtitle ?? row.subtitle,
      authors: body.authors ?? row.authors,
      topic: body.topic ?? row.topic,
      targetAudience: body.targetAudience ?? row.targetAudience,
      totalPagesBudget: body.totalPagesBudget ?? row.totalPagesBudget,
      equationFrequencyLevel: body.equationFrequencyLevel ?? row.equationFrequencyLevel,
      doConsiderOutline: body.doConsiderOutline ?? row.doConsiderOutline,
      doConsiderPreviousSections: body.doConsiderPreviousSections ?? row.doConsiderPreviousSections,
      outputFormat: body.outputFormat ?? row.outputFormat,
      maxOutlineLevels: body.maxOutlineLevels ?? row.maxOutlineLevels,
      llmModel: body.llmModel ?? row.llmModel,
      updatedAt: db.now(),
    });
    return HttpResponse.json(db.getProject(projectId));
  }),

  http.delete('*/api/v1/projects/:projectId', ({ params, request }) => {
    const projectId = params.projectId as string;
    if (!db.projects.has(projectId)) return notFound('Project', new URL(request.url).pathname);
    db.projects.delete(projectId);
    for (const [id, source] of db.sources)
      if (source.projectId === projectId) db.sources.delete(id);
    for (const [id, node] of db.outlineNodes)
      if (node.projectId === projectId) db.outlineNodes.delete(id);
    for (const [id, run] of db.runs) if (run.projectId === projectId) db.runs.delete(id);
    return new HttpResponse(null, { status: 204 });
  }),

  http.post('*/api/v1/projects/:projectId/duplicate', ({ params, request }) => {
    const source = db.getProject(params.projectId as string);
    if (!source) return notFound('Project', new URL(request.url).pathname);
    const row = createProjectRow({
      title: `${source.title} (Copy)`,
      subtitle: source.subtitle,
      authors: source.authors,
      topic: source.topic,
      targetAudience: source.targetAudience,
      totalPagesBudget: source.totalPagesBudget,
      equationFrequencyLevel: source.equationFrequencyLevel,
      doConsiderOutline: source.doConsiderOutline,
      doConsiderPreviousSections: source.doConsiderPreviousSections,
      outputFormat: source.outputFormat,
      maxOutlineLevels: source.maxOutlineLevels,
      llmModel: source.llmModel,
      ...(source.additionalRequirements
        ? { additionalRequirements: source.additionalRequirements }
        : {}),
    });
    db.projects.set(row.id, row);
    for (const src of source.sources ?? []) {
      const id = db.nextId();
      db.sources.set(id, { ...src, id, projectId: row.id });
    }
    insertOutlineTree(
      treeToReplace(source.outline ?? []),
      row.id,
      null,
      1,
      '',
      '',
      row.maxOutlineLevels,
    );
    return HttpResponse.json(db.getProject(row.id), { status: 201 });
  }),
];

function treeToReplace(nodes: OutlineNodeTree[]): OutlineTreeReplace {
  return nodes.map((node): OutlineTreeReplaceNode => ({
    title: node.title,
    summary: node.summary,
    targetPages: node.targetPages,
    mathLevel: node.mathLevel,
    equationDensityLevel: node.equationDensityLevel,
    ...(node.subPrompt ? { subPrompt: node.subPrompt } : {}),
    ...(node.children?.length ? { children: treeToReplace(node.children) } : {}),
  }));
}

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

function attachSource(
  projectId: string,
  body: SourceCreate,
): { source?: Source; error?: { status: number; title: string } } {
  const file = db.files.get(body.fileId);
  if (!file) return { error: { status: 404, title: 'File not found' } };
  if (!file.kbEligible) return { error: { status: 422, title: 'File is not KB-eligible' } };
  const alreadyAttached = [...db.sources.values()].some(
    (s) => s.projectId === projectId && s.fileId === body.fileId,
  );
  if (alreadyAttached)
    return { error: { status: 409, title: 'File is already attached to the project' } };
  const id = db.nextId();
  const type = body.type ?? EXTENSION_SOURCE_TYPE[extensionOf(file.filename)] ?? 'notes';
  const source: Source & { projectId: string } = {
    projectId,
    id,
    fileId: file.id,
    name: file.filename,
    sizeBytes: file.sizeBytes,
    type,
    chunksCount: null,
    status: 'ready',
    uploadDate: file.createdAt,
    authors: body.authors ?? null,
    year: body.year ?? null,
    doi: body.doi ?? null,
    url: body.url ?? null,
    description: body.description ?? null,
  };
  db.sources.set(id, source);
  return { source };
}

const sourceHandlers = [
  http.get('*/api/v1/projects/:projectId/sources', ({ params, request }) => {
    const projectId = params.projectId as string;
    if (!db.projects.has(projectId)) return notFound('Project', new URL(request.url).pathname);
    return HttpResponse.json(paginate(db.sourcesForProject(projectId), new URL(request.url)));
  }),

  http.post('*/api/v1/projects/:projectId/sources', async ({ params, request }) => {
    const projectId = params.projectId as string;
    if (!db.projects.has(projectId)) return notFound('Project', new URL(request.url).pathname);
    const body = (await request.json()) as SourceCreate;
    const { source, error } = attachSource(projectId, body);
    if (error) return problemResponse(error.status, error.title, new URL(request.url).pathname);
    db.touchProject(projectId);
    return HttpResponse.json(source, { status: 201 });
  }),

  http.get('*/api/v1/projects/:projectId/sources/:sourceId', ({ params, request }) => {
    const source = db.sources.get(params.sourceId as string);
    if (!source || source.projectId !== params.projectId)
      return notFound('Source', new URL(request.url).pathname);
    return HttpResponse.json(stripProjectId(source));
  }),

  http.patch('*/api/v1/projects/:projectId/sources/:sourceId', async ({ params, request }) => {
    const source = db.sources.get(params.sourceId as string);
    if (!source || source.projectId !== params.projectId)
      return notFound('Source', new URL(request.url).pathname);
    const body = (await request.json()) as SourceUpdate;
    // `SourceUpdate.type` is `SourceType | null | undefined` on the wire
    // (only present when the caller actually wants to change it) - fall
    // back to the existing value so the map never stores a `null` type.
    const updated = { ...source, ...body, type: body.type ?? source.type };
    db.sources.set(source.id, updated);
    return HttpResponse.json(stripProjectId(updated));
  }),

  http.delete('*/api/v1/projects/:projectId/sources/:sourceId', ({ params, request }) => {
    const source = db.sources.get(params.sourceId as string);
    if (!source || source.projectId !== params.projectId)
      return notFound('Source', new URL(request.url).pathname);
    db.sources.delete(source.id);
    pruneSourceFromOutline(source.projectId, source.id);
    return new HttpResponse(null, { status: 204 });
  }),
];

// ---------------------------------------------------------------------------
// outline
// ---------------------------------------------------------------------------

/** Stands in for the API's re-anchoring on every `contentMarkdown` PATCH. */
function reanchorComments(nodeId: string, content: string): void {
  for (const comment of db.comments.values()) {
    if (comment.nodeId !== nodeId || comment.parentId !== null || !comment.anchor) continue;
    if (comment.kind === 'suggestion' && comment.status !== 'pending') continue;
    const resolved = resolveAnchor(content, comment.anchor);
    const orphaned = resolved.start === null;
    const status =
      comment.status === 'resolved'
        ? 'resolved'
        : comment.kind === 'comment' || comment.kind === 'review'
          ? orphaned
            ? 'orphaned'
            : 'open'
          : comment.status;
    const next = { ...comment, anchor: resolved, status, updatedAt: db.now() };
    db.comments.set(comment.id, next);
    for (const reply of db.comments.values()) {
      if (reply.threadId === comment.id && reply.id !== comment.id) {
        db.comments.set(reply.id, { ...reply, anchor: resolved, status });
      }
    }
  }
}

const outlineHandlers = [
  http.get('*/api/v1/projects/:projectId/outline', ({ params, request }) => {
    const projectId = params.projectId as string;
    if (!db.projects.has(projectId)) return notFound('Project', new URL(request.url).pathname);
    const url = new URL(request.url);
    const format = url.searchParams.get('format') ?? 'flat';
    const flat = db.outlineFlatForProject(projectId);
    if (format === 'tree') {
      const tree = db.outlineTreeForProject(projectId);
      return HttpResponse.json({ ...paginate(tree, url), total: flat.length });
    }
    return HttpResponse.json(paginate(flat, url));
  }),

  http.put('*/api/v1/projects/:projectId/outline', async ({ params, request }) => {
    const projectId = params.projectId as string;
    const row = db.projects.get(projectId);
    if (!row) return notFound('Project', new URL(request.url).pathname);
    const body = (await request.json()) as OutlineTreeReplace;
    for (const [id, node] of db.outlineNodes)
      if (node.projectId === projectId) db.outlineNodes.delete(id);
    const result = insertOutlineTree(body, projectId, null, 1, '', '', row.maxOutlineLevels);
    if (result.error) return problemResponse(422, result.error, new URL(request.url).pathname);
    return HttpResponse.json(paginate(db.outlineFlatForProject(projectId), new URL(request.url)));
  }),

  http.post('*/api/v1/projects/:projectId/outline', async ({ params, request }) => {
    const projectId = params.projectId as string;
    const row = db.projects.get(projectId);
    if (!row) return notFound('Project', new URL(request.url).pathname);
    const body = (await request.json()) as OutlineNodeCreate;
    if (body.parentId && !db.outlineNodes.get(body.parentId)) {
      return notFound('Parent node', new URL(request.url).pathname);
    }
    if (body.parentId && db.outlineNodes.get(body.parentId)?.contentLocked) {
      return problemResponse(
        409,
        `outline node ${body.parentId} is content-locked; unlock it before adding sections under it`,
        new URL(request.url).pathname,
      );
    }
    const depth = outlineDepthOf(body.parentId ?? null) + 1;
    if (depth > row.maxOutlineLevels) {
      return problemResponse(
        422,
        `Depth would exceed maxOutlineLevels (${row.maxOutlineLevels})`,
        new URL(request.url).pathname,
      );
    }
    const siblings = [...db.outlineNodes.values()].filter(
      (n) => n.projectId === projectId && n.parentId === (body.parentId ?? null),
    );
    const orderIndex = body.orderIndex ?? siblings.length;
    const parent = body.parentId ? db.outlineNodes.get(body.parentId) : undefined;
    const sectionNumber = parent
      ? `${parent.sectionNumber}.${orderIndex + 1}`
      : `${orderIndex + 1}`;
    const cliKey = parent?.cliKey ? `${parent.cliKey}-${orderIndex + 1}` : `${orderIndex + 1}`;
    const id = db.nextId();
    const now = db.now();
    const node: OutlineNode & { projectId: string } = {
      projectId,
      id,
      parentId: body.parentId ?? null,
      orderIndex,
      cliKey,
      title: body.title,
      summary: body.summary ?? '',
      level: depth,
      sectionNumber,
      status: 'not_started',
      targetPages: body.targetPages ?? 1,
      wordBudget: Math.round((body.targetPages ?? 1) * 350),
      actualWords: 0,
      equationDensityLevel: body.equationDensityLevel ?? row.equationFrequencyLevel,
      mathLevel: body.mathLevel ?? 'rigorous',
      subPrompt: body.subPrompt ?? null,
      contentMarkdown: '',
      contentLatex: '',
      ragCitations: [],
      reviewerScore: null,
      reviewerNotes: null,
      structureLocked: false,
      contentLocked: false,
      sourceScope: 'inherit',
      sourceIds: [],
      createdAt: now,
      updatedAt: now,
    };
    db.outlineNodes.set(id, node);
    return HttpResponse.json(stripProjectId(node), { status: 201 });
  }),

  http.get('*/api/v1/projects/:projectId/outline/:nodeId', ({ params, request }) => {
    const node = db.outlineNodes.get(params.nodeId as string);
    if (!node || node.projectId !== params.projectId)
      return notFound('Outline node', new URL(request.url).pathname);
    return HttpResponse.json(db.withCommentCounts(stripProjectId(node)));
  }),

  http.patch('*/api/v1/projects/:projectId/outline/:nodeId', async ({ params, request }) => {
    const node = db.outlineNodes.get(params.nodeId as string);
    if (!node || node.projectId !== params.projectId)
      return notFound('Outline node', new URL(request.url).pathname);
    const body = (await request.json()) as OutlineNodeUpdate & Record<string, unknown>;
    const forbidden = ['level', 'sectionNumber', 'cliKey', 'actualWords'].filter(
      (key) => key in body,
    );
    if (forbidden.length) {
      return problemResponse(
        422,
        `Server-derived fields cannot be set: ${forbidden.join(', ')}`,
        new URL(request.url).pathname,
      );
    }
    const scope = normalizeSourceScope(node, body);
    if ('error' in scope) {
      return problemResponse(422, scope.error, new URL(request.url).pathname);
    }
    const lock = normalizeContentLock(node, body);
    if ('error' in lock) {
      return problemResponse(lock.status, lock.error, new URL(request.url).pathname);
    }
    if (
      body.parentId &&
      body.parentId !== node.parentId &&
      db.outlineNodes.get(body.parentId)?.contentLocked
    ) {
      return problemResponse(
        409,
        `outline node ${body.parentId} is content-locked; unlock it before adding sections under it`,
        new URL(request.url).pathname,
      );
    }
    const updated: OutlineNode & { projectId: string } = {
      ...node,
      ...(body as Partial<OutlineNode>),
      ...scope,
      ...lock,
      actualWords:
        body.contentMarkdown != null
          ? body.contentMarkdown.trim().split(/\s+/).filter(Boolean).length
          : node.actualWords,
      updatedAt: db.now(),
    };
    db.outlineNodes.set(node.id, updated);
    if (body.contentMarkdown != null) reanchorComments(node.id, updated.contentMarkdown);
    return HttpResponse.json(db.withCommentCounts(stripProjectId(updated)));
  }),

  http.delete('*/api/v1/projects/:projectId/outline/:nodeId', ({ params, request }) => {
    const node = db.outlineNodes.get(params.nodeId as string);
    if (!node || node.projectId !== params.projectId)
      return notFound('Outline node', new URL(request.url).pathname);
    deleteOutlineSubtree(node.id);
    return new HttpResponse(null, { status: 204 });
  }),

  // Issue #113: one bulk clear of every content lock; idempotent, returns the whole outline.
  http.post('*/api/v1/projects/:projectId/outline/unlock-all', ({ params, request }) => {
    const projectId = params.projectId as string;
    if (!db.projects.has(projectId)) return notFound('Project', new URL(request.url).pathname);
    const now = db.now();
    for (const node of db.outlineNodes.values()) {
      if (node.projectId === projectId && node.contentLocked) {
        db.outlineNodes.set(node.id, { ...node, contentLocked: false, updatedAt: now });
      }
    }
    const flat = db.outlineFlatForProject(projectId);
    return HttpResponse.json({
      items: flat,
      total: flat.length,
      limit: Math.max(flat.length, 1),
      offset: 0,
    });
  }),

  http.post(
    '*/api/v1/projects/:projectId/outline/:nodeId/regenerate',
    async ({ params, request }) => {
      const projectId = params.projectId as string;
      const project = db.projects.get(projectId);
      const node = db.outlineNodes.get(params.nodeId as string);
      if (!project || !node || node.projectId !== projectId) {
        return notFound('Project or node', new URL(request.url).pathname);
      }
      const keyRequired = llmKeyRequiredProblem(request);
      if (keyRequired) return keyRequired;
      if (!project.lastRunId || !db.runs.get(project.lastRunId)?.resumable) {
        return problemResponse(
          409,
          'No successful prior run to resume from',
          new URL(request.url).pathname,
        );
      }
      if (node.status === 'drafting') {
        return problemResponse(
          409,
          `outline node ${node.id} already has a regenerate queued or running; wait for it to finish or cancel it`,
          new URL(request.url).pathname,
        );
      }
      if (node.contentLocked) {
        return problemResponse(
          409,
          `outline node ${node.id} is content-locked; unlock it first to regenerate it`,
          new URL(request.url).pathname,
        );
      }
      const admissionBlocker = queueAdmissionBlocker(true, laneRunsFor(projectId));
      if (admissionBlocker) {
        return problemResponse(409, admissionBlocker, new URL(request.url).pathname);
      }
      const body = (await request.json().catch(() => ({}))) as RegenerateRequest;
      const runId = db.nextId();
      const run: Run = {
        id: runId,
        projectId,
        kind: 'regenerate_section',
        status: 'queued',
        options: {
          outline: 'project',
          outputFormat: project.outputFormat,
          allowSubdivision: true,
          enableWebRag: false,
          auditBook: false,
          auditBookMode: 'warn',
          legacyTex: false,
          rebuildKb: false,
          failFastSchema: false,
          resume: true,
          exportTexOnly: false,
          promptModifier: body.promptModifier ?? null,
          llmModel:
            (project.lastRunId && db.runs.get(project.lastRunId)?.options.llmModel) ||
            project.llmModel,
        },
        baseRunId: project.lastRunId,
        targetNodeId: node.id,
        exitCode: null,
        error: null,
        totalTokens: null,
        totalCostUsd: null,
        resumable: true,
        // A `regenerate_section` run is never retryable (issue #124: only `kind === 'full'` is).
        retryable: false,
        queuedAt: db.now(),
        startedAt: null,
        finishedAt: null,
        startedById: MOCK_USER.id,
        startedByName: MOCK_USER.displayName,
      };
      db.runs.set(runId, run);
      db.outlineNodes.set(node.id, { ...node, status: 'drafting' });
      driveFakeRun(runId);
      return HttpResponse.json(withQueuePosition(run), { status: 202 });
    },
  ),
];

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

const runHandlers = [
  http.get('*/api/v1/projects/:projectId/runs', ({ params, request }) => {
    const projectId = params.projectId as string;
    if (!db.projects.has(projectId)) return notFound('Project', new URL(request.url).pathname);
    const url = new URL(request.url);
    const statusFilter = url.searchParams.getAll('status');
    const runs = [...db.runs.values()]
      .filter((run) => run.projectId === projectId)
      .filter((run) => statusFilter.length === 0 || statusFilter.includes(run.status))
      .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))
      .map(withQueuePosition);
    return HttpResponse.json(paginate(runs, url));
  }),

  http.post('*/api/v1/projects/:projectId/runs', async ({ params, request }) => {
    const projectId = params.projectId as string;
    if (!db.projects.has(projectId)) return notFound('Project', new URL(request.url).pathname);
    const keyRequired = llmKeyRequiredProblem(request);
    if (keyRequired) return keyRequired;
    const admissionBlocker = queueAdmissionBlocker(false, laneRunsFor(projectId));
    if (admissionBlocker) {
      return problemResponse(409, admissionBlocker, new URL(request.url).pathname);
    }
    const body = (await request.json().catch(() => ({}))) as RunOptionsIn;
    if (
      body.legacyTex &&
      !body.unlockAll &&
      (body.outline ?? 'project') === 'project' &&
      db.outlineFlatForProject(projectId).some((node) => node.contentLocked)
    ) {
      return problemResponse(
        422,
        'legacyTex cannot be combined with content-locked sections (their text is Markdown); unlock them first or run without legacyTex',
        new URL(request.url).pathname,
      );
    }
    if (body.unlockAll) {
      // Issue #113: cleared only now, after every check above has passed.
      for (const node of db.outlineNodes.values()) {
        if (node.projectId === projectId && node.contentLocked) {
          db.outlineNodes.set(node.id, { ...node, contentLocked: false, updatedAt: db.now() });
        }
      }
    }
    const runId = db.nextId();
    const run: Run = {
      id: runId,
      projectId,
      kind: 'full',
      status: 'queued',
      options: {
        outline: body.outline ?? 'project',
        outputFormat: body.outputFormat ?? db.projects.get(projectId)?.outputFormat ?? 'markdown',
        allowSubdivision: body.allowSubdivision ?? true,
        enableWebRag: body.enableWebRag ?? false,
        auditBook: body.auditBook ?? false,
        auditBookMode: body.auditBookMode ?? 'warn',
        legacyTex: body.legacyTex ?? false,
        rebuildKb: false,
        failFastSchema: body.failFastSchema ?? false,
        resume: false,
        exportTexOnly: false,
        llmModel: body.llmModel ?? db.projects.get(projectId)?.llmModel ?? DEFAULT_MOCK_LLM_MODEL,
      },
      baseRunId: null,
      targetNodeId: null,
      exitCode: null,
      error: null,
      totalTokens: null,
      totalCostUsd: null,
      resumable: true,
      // Just queued, not `failed`/`cancelled` yet (issue #124).
      retryable: false,
      queuedAt: db.now(),
      startedAt: null,
      finishedAt: null,
      startedById: MOCK_USER.id,
      startedByName: MOCK_USER.displayName,
    };
    db.runs.set(runId, run);
    driveFakeRun(runId);
    return HttpResponse.json(withQueuePosition(run), { status: 202 });
  }),

  http.get('*/api/v1/runs/:runId', ({ params, request }) => {
    const run = db.runs.get(params.runId as string);
    if (!run) return notFound('Run', new URL(request.url).pathname);
    return HttpResponse.json(withQueuePosition(run));
  }),

  http.post('*/api/v1/runs/:runId/cancel', ({ params, request }) => {
    const run = db.runs.get(params.runId as string);
    if (!run) return notFound('Run', new URL(request.url).pathname);
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
      return problemResponse(
        409,
        'Run is already in a terminal state',
        new URL(request.url).pathname,
      );
    }
    const cancelled: Run = { ...run, status: 'cancelled', finishedAt: db.now() };
    db.runs.set(run.id, cancelled);
    // The lane's running slot may have just been freed (cancelling a `running` run) — let the
    // next queued run in this project's lane claim it (issue #134); a no-op if `run` was only
    // ever `queued` itself, or if the project's lane is still busy with something else.
    claimNextQueued(run.projectId);
    db.publishRunEvent(run.id, 'done', {
      seq: db.nextSeq(run.id),
      ts: db.now(),
      level: 'warn',
      stage: '',
      message: 'Run cancelled.',
    });
    return HttpResponse.json(withQueuePosition(cancelled), { status: 202 });
  }),

  http.get('*/api/v1/runs/:runId/events', ({ params, request }) => {
    const run = db.runs.get(params.runId as string);
    if (!run) return notFound('Run', new URL(request.url).pathname);
    const url = new URL(request.url);
    const afterSeq = Number(url.searchParams.get('afterSeq') ?? 0);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 200), 1), 500);
    const matching = (db.runEvents.get(run.id) ?? []).filter((event) => event.seq > afterSeq);
    const items = matching.slice(0, limit);
    const page: RunEventPage = {
      items,
      total: matching.length,
      limit,
      afterSeq: items.at(-1)?.seq ?? afterSeq,
    };
    return HttpResponse.json(page);
  }),

  http.get('*/api/v1/runs/:runId/artifacts', ({ params, request }) => {
    const run = db.runs.get(params.runId as string);
    if (!run) return notFound('Run', new URL(request.url).pathname);
    const url = new URL(request.url);
    // `?kind=` (issue #129 review, fix 6) - mirrors `list_run_artifacts`'s own filter, applied
    // before pagination so a kind-scoped fetch (`ArtifactsList`'s per-kind queries) gets that
    // kind's own full page instead of racing every other kind for the same 200 rows.
    const kind = url.searchParams.get('kind');
    const all = db.runArtifacts.get(run.id) ?? [];
    const filtered = kind ? all.filter((artifact) => artifact.kind === kind) : all;
    return HttpResponse.json(paginate(filtered, url));
  }),

  http.get('*/api/v1/runs/:runId/artifacts/summary', ({ params, request }) => {
    const run = db.runs.get(params.runId as string);
    if (!run) return notFound('Run', new URL(request.url).pathname);
    const countsByKind: Record<string, number> = {};
    for (const artifact of db.runArtifacts.get(run.id) ?? []) {
      countsByKind[artifact.kind] = (countsByKind[artifact.kind] ?? 0) + 1;
    }
    return HttpResponse.json({ countsByKind });
  }),

  http.post('*/api/v1/runs/:runId/exports', async ({ params, request }) => {
    const baseRun = db.runs.get(params.runId as string);
    if (!baseRun) return notFound('Run', new URL(request.url).pathname);
    const keyRequired = llmKeyRequiredProblem(request);
    if (keyRequired) return keyRequired;
    if (baseRun.status !== 'succeeded' || !baseRun.resumable) {
      return problemResponse(
        409,
        'Base run is not succeeded, or its work dir is gone',
        new URL(request.url).pathname,
      );
    }
    const exportsAdmissionBlocker = queueAdmissionBlocker(true, laneRunsFor(baseRun.projectId));
    if (exportsAdmissionBlocker) {
      return problemResponse(409, exportsAdmissionBlocker, new URL(request.url).pathname);
    }
    const body = (await request.json()) as ExportRequest;
    const runId = db.nextId();
    const run: Run = {
      id: runId,
      projectId: baseRun.projectId,
      kind: 'export',
      // Mirrors `RunService.export` (`api/application/runs.py`): the base run's options carried
      // forward, with `outputFormat` overridden to the requested export format, `resume`/
      // `exportTexOnly` forced on, and `promptModifier` cleared.
      status: 'queued',
      options: {
        ...baseRun.options,
        outputFormat: body.format,
        resume: true,
        exportTexOnly: true,
        promptModifier: null,
      },
      baseRunId: baseRun.id,
      targetNodeId: null,
      exitCode: null,
      error: null,
      totalTokens: null,
      totalCostUsd: null,
      resumable: true,
      // An `export` run is never retryable (issue #124: only `kind === 'full'` is).
      retryable: false,
      queuedAt: db.now(),
      startedAt: null,
      finishedAt: null,
      startedById: MOCK_USER.id,
      startedByName: MOCK_USER.displayName,
    };
    db.runs.set(runId, run);
    driveFakeRun(runId);
    return HttpResponse.json(withQueuePosition(run), { status: 202 });
  }),

  http.post('*/api/v1/runs/:runId/retry', ({ params, request }) => {
    const baseRun = db.runs.get(params.runId as string);
    if (!baseRun) return notFound('Run', new URL(request.url).pathname);
    const keyRequired = llmKeyRequiredProblem(request);
    if (keyRequired) return keyRequired;
    if (baseRun.kind !== 'full') {
      return problemResponse(
        409,
        'Only a full run can be resumed; re-run regenerate/export instead',
        new URL(request.url).pathname,
      );
    }
    if (baseRun.status !== 'failed' && baseRun.status !== 'cancelled') {
      return problemResponse(
        409,
        baseRun.status === 'succeeded'
          ? 'Run succeeded; nothing to resume; use export/regenerate'
          : 'Run is still active; cancel it first',
        new URL(request.url).pathname,
      );
    }
    if (!baseRun.resumable) {
      return problemResponse(
        409,
        "Run's work directory no longer exists; start a full run",
        new URL(request.url).pathname,
      );
    }
    const retryAdmissionBlocker = queueAdmissionBlocker(true, laneRunsFor(baseRun.projectId));
    if (retryAdmissionBlocker) {
      return problemResponse(409, retryAdmissionBlocker, new URL(request.url).pathname);
    }
    const runId = db.nextId();
    const run: Run = {
      ...baseRun,
      id: runId,
      status: 'queued',
      options: { ...baseRun.options, resume: true, exportTexOnly: false, promptModifier: null },
      baseRunId: baseRun.id,
      targetNodeId: null,
      exitCode: null,
      error: null,
      totalTokens: null,
      totalCostUsd: null,
      resumable: true,
      retryable: false,
      queuedAt: db.now(),
      startedAt: null,
      finishedAt: null,
      startedById: MOCK_USER.id,
      startedByName: MOCK_USER.displayName,
    };
    db.runs.set(runId, run);
    driveFakeRun(runId);
    return HttpResponse.json(withQueuePosition(run), { status: 202 });
  }),
];

// ---------------------------------------------------------------------------
// comments (margin cards, issue #182)
// ---------------------------------------------------------------------------

/** Whole threads (root first, replies oldest first), ordered by root creation, optionally filtered like the API. */
function threadRows(rows: Comment[], url: URL): Comment[] {
  const kind = url.searchParams.get('kind');
  const status = url.searchParams.get('status');
  const roots = rows
    .filter((row) => row.parentId === null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const out: Comment[] = [];
  for (const root of roots) {
    const thread = rows
      .filter((row) => row.threadId === root.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (kind && !thread.some((row) => row.kind === kind)) continue;
    if (status) {
      const subject = kind ? thread.filter((row) => row.kind === kind) : [root];
      if (!subject.some((row) => row.status === status)) continue;
    }
    out.push(...thread);
  }
  return out;
}

function commentPage(rows: Comment[]): Page<Comment> {
  const items = rows;
  return {
    items,
    total: items.filter((row) => row.parentId === null).length,
    limit: items.length,
    offset: 0,
  };
}

function projectNode(projectId: string, nodeId: string) {
  const node = db.outlineNodes.get(nodeId);
  return node && node.projectId === projectId ? node : undefined;
}

const commentHandlers = [
  http.get('*/api/v1/projects/:projectId/comments', ({ params, request }) => {
    const projectId = params.projectId as string;
    if (!db.projects.has(projectId)) return notFound('Project', new URL(request.url).pathname);
    const rows = [...db.comments.values()].filter((row) => row.projectId === projectId);
    return HttpResponse.json(commentPage(threadRows(rows, new URL(request.url))));
  }),

  http.get('*/api/v1/projects/:projectId/outline/:nodeId/comments', ({ params, request }) => {
    const node = projectNode(params.projectId as string, params.nodeId as string);
    if (!node) return notFound('Outline node', new URL(request.url).pathname);
    const rows = [...db.comments.values()].filter((row) => row.nodeId === node.id);
    return HttpResponse.json(commentPage(threadRows(rows, new URL(request.url))));
  }),

  http.post(
    '*/api/v1/projects/:projectId/outline/:nodeId/comments',
    async ({ params, request }) => {
      const instance = new URL(request.url).pathname;
      const node = projectNode(params.projectId as string, params.nodeId as string);
      if (!node) return notFound('Outline node', instance);
      const body = (await request.json()) as CommentCreate;
      if (!body.bodyMarkdown || !body.bodyMarkdown.trim()) {
        return problemResponse(
          422,
          'Validation Failed',
          instance,
          'bodyMarkdown must not be blank',
        );
      }
      const now = db.now();
      const id = db.nextId();
      if (body.parentId) {
        const parent = db.comments.get(body.parentId);
        if (!parent || parent.nodeId !== node.id) return notFound('Comment', instance);
        if (parent.kind === 'suggestion') {
          return problemResponse(
            409,
            'Conflict',
            instance,
            'replies under a suggestion are not allowed',
          );
        }
        const root = db.comments.get(parent.threadId) ?? parent;
        const status =
          root.status === 'resolved'
            ? root.anchor && root.anchor.start == null
              ? 'orphaned'
              : 'open'
            : root.status;
        if (status !== root.status) {
          for (const row of db.comments.values()) {
            if (row.threadId === root.id)
              db.comments.set(row.id, { ...row, status, updatedAt: now });
          }
        }
        const reply: Comment = {
          id,
          projectId: node.projectId,
          nodeId: node.id,
          kind: 'comment',
          authorId: MOCK_USER.id,
          authorName: MOCK_USER.displayName,
          anchor: root.anchor,
          status,
          threadId: root.id,
          parentId: root.id,
          bodyMarkdown: body.bodyMarkdown,
          payload: {},
          createdAt: now,
          updatedAt: now,
          editedAt: null,
        };
        db.comments.set(id, reply);
        return HttpResponse.json(reply, { status: 201 });
      }
      let anchor: Comment['anchor'] = null;
      let status: Comment['status'] = 'open';
      if (body.anchor) {
        const resolved = resolveAnchor(node.contentMarkdown, body.anchor);
        anchor = resolved;
        if (resolved.start === null) status = 'orphaned';
      }
      const comment: Comment = {
        id,
        projectId: node.projectId,
        nodeId: node.id,
        kind: 'comment',
        authorId: MOCK_USER.id,
        authorName: MOCK_USER.displayName,
        anchor,
        status,
        threadId: id,
        parentId: null,
        bodyMarkdown: body.bodyMarkdown,
        payload: {},
        createdAt: now,
        updatedAt: now,
        editedAt: null,
      };
      db.comments.set(id, comment);
      return HttpResponse.json(comment, { status: 201 });
    },
  ),

  http.patch('*/api/v1/comments/:commentId', async ({ params, request }) => {
    const instance = new URL(request.url).pathname;
    const comment = db.comments.get(params.commentId as string);
    if (!comment) return notFound('Comment', instance);
    if (comment.authorId !== MOCK_USER.id || comment.kind !== 'comment') {
      return problemResponse(403, 'Forbidden', instance, 'only the author can edit a comment');
    }
    const body = (await request.json()) as { bodyMarkdown: string };
    if (!body.bodyMarkdown.trim()) {
      return problemResponse(422, 'Validation Failed', instance, 'bodyMarkdown must not be blank');
    }
    const now = db.now();
    const updated = { ...comment, bodyMarkdown: body.bodyMarkdown, editedAt: now, updatedAt: now };
    db.comments.set(comment.id, updated);
    return HttpResponse.json(updated);
  }),

  http.delete('*/api/v1/comments/:commentId', ({ params, request }) => {
    const instance = new URL(request.url).pathname;
    const comment = db.comments.get(params.commentId as string);
    if (!comment) return notFound('Comment', instance);
    if (comment.authorId !== null && comment.authorId !== MOCK_USER.id) {
      return problemResponse(403, 'Forbidden', instance, 'only the author can delete a comment');
    }
    for (const row of [...db.comments.values()]) {
      if (row.id === comment.id || (comment.parentId === null && row.threadId === comment.id)) {
        db.comments.delete(row.id);
      }
    }
    return new HttpResponse(null, { status: 204 });
  }),

  http.post('*/api/v1/comments/:commentId/resolve', async ({ params, request }) => {
    const instance = new URL(request.url).pathname;
    const comment = db.comments.get(params.commentId as string);
    if (!comment) return notFound('Comment', instance);
    if (comment.parentId !== null || comment.kind === 'suggestion') {
      return problemResponse(
        409,
        'Conflict',
        instance,
        'only a comment or review thread can be resolved',
      );
    }
    const body = (await request.json().catch(() => ({}))) as { resolved?: boolean };
    const resolved = body.resolved ?? true;
    const now = db.now();
    const status: Comment['status'] = resolved
      ? 'resolved'
      : comment.anchor && comment.anchor.start == null
        ? 'orphaned'
        : 'open';
    for (const row of [...db.comments.values()]) {
      if (row.threadId === comment.id) db.comments.set(row.id, { ...row, status, updatedAt: now });
    }
    return HttpResponse.json(db.comments.get(comment.id));
  }),
];

const streamHandler = sse<Record<'log' | 'stage' | 'section' | 'done', RunEvent>>(
  '*/api/v1/runs/:runId/events/stream',
  ({ params, client, request }) => {
    const runId = params.runId as string;
    if (!db.runs.has(runId)) {
      client.error();
      return;
    }
    const url = new URL(request.url);
    const lastEventId = Number(
      url.searchParams.get('lastEventId') ?? request.headers.get('last-event-id') ?? 0,
    );

    for (const event of db.runEvents.get(runId) ?? []) {
      if (event.seq > lastEventId) {
        client.send({ id: String(event.seq), event: 'log', data: event });
      }
    }

    const unsubscribe = db.onRunEvent(runId, (event, name) => {
      client.send({ id: String(event.seq), event: name, data: event });
      if (name === 'done') client.close();
    });
    request.signal.addEventListener('abort', unsubscribe);
  },
);

export const handlers = [
  ...systemHandlers,
  ...authHandlers,
  ...fileHandlers,
  ...projectHandlers,
  ...sourceHandlers,
  ...outlineHandlers,
  ...commentHandlers,
  ...runHandlers,
  streamHandler,
];

export type { Problem };
