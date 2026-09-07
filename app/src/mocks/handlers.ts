import { http, HttpResponse, sse } from 'msw';

import { driveFakeRun } from './fakeRun';
import { db, stripProjectId, type ProjectRow } from './db';
import { notFound, problemResponse } from './problem';
import type {
  ExportRequest,
  FileDto,
  HealthStatus,
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
  RunOptions,
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

function hasActiveRun(projectId: string): boolean {
  return [...db.runs.values()].some(
    (run) => run.projectId === projectId && (run.status === 'queued' || run.status === 'running'),
  );
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
    db.projects.set(projectId, { ...row, ...body, updatedAt: db.now() });
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
      ...(source.additionalRequirements
        ? { additionalRequirements: source.additionalRequirements }
        : {}),
    });
    db.projects.set(row.id, row);
    for (const src of source.sources) {
      const id = db.nextId();
      db.sources.set(id, { ...src, id, projectId: row.id });
    }
    insertOutlineTree(treeToReplace(source.outline), row.id, null, 1, '', '', row.maxOutlineLevels);
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
    ...(node.children.length ? { children: treeToReplace(node.children) } : {}),
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
    const updated = { ...source, ...body };
    db.sources.set(source.id, updated);
    return HttpResponse.json(stripProjectId(updated));
  }),

  http.delete('*/api/v1/projects/:projectId/sources/:sourceId', ({ params, request }) => {
    const source = db.sources.get(params.sourceId as string);
    if (!source || source.projectId !== params.projectId)
      return notFound('Source', new URL(request.url).pathname);
    db.sources.delete(source.id);
    return new HttpResponse(null, { status: 204 });
  }),
];

// ---------------------------------------------------------------------------
// outline
// ---------------------------------------------------------------------------

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
    return HttpResponse.json(stripProjectId(node));
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
    const updated: OutlineNode & { projectId: string } = {
      ...node,
      ...(body as Partial<OutlineNode>),
      actualWords:
        body.contentMarkdown !== undefined
          ? body.contentMarkdown.trim().split(/\s+/).filter(Boolean).length
          : node.actualWords,
      updatedAt: db.now(),
    };
    db.outlineNodes.set(node.id, updated);
    return HttpResponse.json(stripProjectId(updated));
  }),

  http.delete('*/api/v1/projects/:projectId/outline/:nodeId', ({ params, request }) => {
    const node = db.outlineNodes.get(params.nodeId as string);
    if (!node || node.projectId !== params.projectId)
      return notFound('Outline node', new URL(request.url).pathname);
    deleteOutlineSubtree(node.id);
    return new HttpResponse(null, { status: 204 });
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
      if (!project.lastRunId || !db.runs.get(project.lastRunId)?.resumable) {
        return problemResponse(
          409,
          'No successful prior run to resume from',
          new URL(request.url).pathname,
        );
      }
      if (hasActiveRun(projectId)) {
        return problemResponse(
          409,
          'Project already has an active run',
          new URL(request.url).pathname,
        );
      }
      const body = (await request.json().catch(() => ({}))) as RegenerateRequest;
      const runId = db.nextId();
      const run: Run = {
        id: runId,
        projectId,
        kind: 'regenerate_section',
        status: 'queued',
        options: { promptModifier: body.promptModifier ?? null, resume: true },
        baseRunId: project.lastRunId,
        targetNodeId: node.id,
        exitCode: null,
        error: null,
        totalTokens: null,
        totalCostUsd: null,
        resumable: true,
        queuedAt: db.now(),
        startedAt: null,
        finishedAt: null,
      };
      db.runs.set(runId, run);
      db.outlineNodes.set(node.id, { ...node, status: 'drafting' });
      driveFakeRun(runId);
      return HttpResponse.json(run, { status: 202 });
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
    const runs = [...db.runs.values()]
      .filter((run) => run.projectId === projectId)
      .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
    return HttpResponse.json(paginate(runs, new URL(request.url)));
  }),

  http.post('*/api/v1/projects/:projectId/runs', async ({ params, request }) => {
    const projectId = params.projectId as string;
    if (!db.projects.has(projectId)) return notFound('Project', new URL(request.url).pathname);
    if (hasActiveRun(projectId)) {
      return problemResponse(
        409,
        'Project already has a queued or running run',
        new URL(request.url).pathname,
      );
    }
    const body = (await request.json().catch(() => ({}))) as RunOptions;
    const runId = db.nextId();
    const run: Run = {
      id: runId,
      projectId,
      kind: 'full',
      status: 'queued',
      options: {
        outline: body.outline ?? 'project',
        outputFormat: body.outputFormat ?? db.projects.get(projectId)?.outputFormat,
        allowSubdivision: body.allowSubdivision ?? false,
        auditBookMode: body.auditBookMode ?? 'warn',
      },
      baseRunId: null,
      targetNodeId: null,
      exitCode: null,
      error: null,
      totalTokens: null,
      totalCostUsd: null,
      resumable: true,
      queuedAt: db.now(),
      startedAt: null,
      finishedAt: null,
    };
    db.runs.set(runId, run);
    driveFakeRun(runId);
    return HttpResponse.json(run, { status: 202 });
  }),

  http.get('*/api/v1/runs/:runId', ({ params, request }) => {
    const run = db.runs.get(params.runId as string);
    if (!run) return notFound('Run', new URL(request.url).pathname);
    return HttpResponse.json(run);
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
    db.publishRunEvent(run.id, 'done', {
      seq: db.nextSeq(run.id),
      ts: db.now(),
      level: 'warn',
      message: 'Run cancelled.',
    });
    return HttpResponse.json(cancelled, { status: 202 });
  }),

  http.get('*/api/v1/runs/:runId/events', ({ params, request }) => {
    const run = db.runs.get(params.runId as string);
    if (!run) return notFound('Run', new URL(request.url).pathname);
    const url = new URL(request.url);
    const afterSeq = Number(url.searchParams.get('afterSeq') ?? 0);
    const events = (db.runEvents.get(run.id) ?? []).filter((event) => event.seq > afterSeq);
    return HttpResponse.json(paginate(events, url));
  }),

  http.get('*/api/v1/runs/:runId/artifacts', ({ params, request }) => {
    const run = db.runs.get(params.runId as string);
    if (!run) return notFound('Run', new URL(request.url).pathname);
    return HttpResponse.json(paginate(db.runArtifacts.get(run.id) ?? [], new URL(request.url)));
  }),

  http.post('*/api/v1/runs/:runId/exports', async ({ params, request }) => {
    const baseRun = db.runs.get(params.runId as string);
    if (!baseRun) return notFound('Run', new URL(request.url).pathname);
    if (baseRun.status !== 'succeeded' || !baseRun.resumable) {
      return problemResponse(
        409,
        'Base run is not succeeded, or its work dir is gone',
        new URL(request.url).pathname,
      );
    }
    if (hasActiveRun(baseRun.projectId)) {
      return problemResponse(
        409,
        'Project already has an active run',
        new URL(request.url).pathname,
      );
    }
    const body = (await request.json()) as ExportRequest;
    const runId = db.nextId();
    const run: Run = {
      id: runId,
      projectId: baseRun.projectId,
      kind: 'export',
      status: 'queued',
      options: { format: body.format, resume: true, exportTexOnly: body.format === 'latex' },
      baseRunId: baseRun.id,
      targetNodeId: null,
      exitCode: null,
      error: null,
      totalTokens: null,
      totalCostUsd: null,
      resumable: true,
      queuedAt: db.now(),
      startedAt: null,
      finishedAt: null,
    };
    db.runs.set(runId, run);
    driveFakeRun(runId);
    return HttpResponse.json(run, { status: 202 });
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
  ...fileHandlers,
  ...projectHandlers,
  ...sourceHandlers,
  ...outlineHandlers,
  ...runHandlers,
  streamHandler,
];

export type { Problem };
