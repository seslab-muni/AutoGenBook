import type {
  FileDto,
  OutlineNode,
  OutlineNodeTree,
  Project,
  ProjectSummary,
  Run,
  RunArtifact,
  RunEvent,
  Source,
} from '@/api/types';

/** Project metadata only — `sources`/`outline` are joined in from their own tables on read. */
export type ProjectRow = Omit<Project, 'sources' | 'outline'>;

interface RunEventListener {
  (event: RunEvent, name: 'log' | 'stage' | 'section' | 'done'): void;
}

/** Drops the `projectId` field this in-memory store attaches to rows for filtering, before returning a DTO. */
export function stripProjectId<T extends { projectId: string }>(row: T): Omit<T, 'projectId'> {
  const dto: Omit<T, 'projectId'> & { projectId?: string } = { ...row };
  delete dto.projectId;
  return dto;
}

class MockDatabase {
  files = new Map<string, FileDto>();
  projects = new Map<string, ProjectRow>();
  sources = new Map<string, Source & { projectId: string }>();
  outlineNodes = new Map<string, OutlineNode & { projectId: string }>();
  runs = new Map<string, Run>();
  runEvents = new Map<string, RunEvent[]>();
  runArtifacts = new Map<string, RunArtifact[]>();
  private runListeners = new Map<string, Set<RunEventListener>>();

  reset(): void {
    this.files.clear();
    this.projects.clear();
    this.sources.clear();
    this.outlineNodes.clear();
    this.runs.clear();
    this.runEvents.clear();
    this.runArtifacts.clear();
    this.runListeners.clear();
  }

  nextId(): string {
    return crypto.randomUUID();
  }

  now(): string {
    return new Date().toISOString();
  }

  sourcesForProject(projectId: string): Source[] {
    return [...this.sources.values()]
      .filter((source) => source.projectId === projectId)
      .map(stripProjectId);
  }

  outlineFlatForProject(projectId: string): OutlineNode[] {
    return [...this.outlineNodes.values()]
      .filter((node) => node.projectId === projectId)
      .map(stripProjectId)
      .sort((a, b) => a.sectionNumber.localeCompare(b.sectionNumber, undefined, { numeric: true }));
  }

  outlineTreeForProject(projectId: string): OutlineNodeTree[] {
    const flat = this.outlineFlatForProject(projectId);
    const byParent = new Map<string | null, OutlineNode[]>();
    for (const node of flat) {
      const siblings = byParent.get(node.parentId) ?? [];
      siblings.push(node);
      byParent.set(node.parentId, siblings);
    }
    function build(parentId: string | null): OutlineNodeTree[] {
      return (byParent.get(parentId) ?? [])
        .sort((a, b) => a.orderIndex - b.orderIndex)
        .map((node) => ({ ...node, children: build(node.id) }));
    }
    return build(null);
  }

  getProject(id: string): Project | undefined {
    const row = this.projects.get(id);
    if (!row) return undefined;
    return { ...row, sources: this.sourcesForProject(id), outline: this.outlineTreeForProject(id) };
  }

  getProjectSummary(id: string): ProjectSummary | undefined {
    const row = this.projects.get(id);
    if (!row) return undefined;
    return {
      id: row.id,
      ownerId: row.ownerId ?? null,
      ownerName: row.ownerName ?? null,
      title: row.title,
      subtitle: row.subtitle,
      authors: row.authors,
      topic: row.topic,
      targetAudience: row.targetAudience,
      totalPagesBudget: row.totalPagesBudget,
      sourcesCount: this.sourcesForProject(id).length,
      outlineNodeCount: this.outlineFlatForProject(id).length,
      lastRunId: row.lastRunId ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  listProjectSummaries(): ProjectSummary[] {
    return [...this.projects.keys()]
      .map((id) => this.getProjectSummary(id))
      .filter((project): project is ProjectSummary => project !== undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  touchProject(id: string): void {
    const row = this.projects.get(id);
    if (row) this.projects.set(id, { ...row, updatedAt: this.now() });
  }

  onRunEvent(runId: string, listener: RunEventListener): () => void {
    const listeners = this.runListeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.runListeners.set(runId, listeners);
    return () => listeners.delete(listener);
  }

  publishRunEvent(
    runId: string,
    name: 'log' | 'stage' | 'section' | 'done',
    event: RunEvent,
  ): void {
    const events = this.runEvents.get(runId) ?? [];
    events.push(event);
    this.runEvents.set(runId, events);
    for (const listener of this.runListeners.get(runId) ?? []) {
      listener(event, name);
    }
  }

  nextSeq(runId: string): number {
    return (this.runEvents.get(runId) ?? []).length + 1;
  }
}

export const db = new MockDatabase();
