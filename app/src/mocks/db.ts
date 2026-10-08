import type {
  Comment,
  FileDto,
  OutlineNode,
  OutlineNodeTree,
  Project,
  ProjectSummary,
  Run,
  RunArtifact,
  RunEvent,
  Source,
  SuggestionProgress,
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

/** Pace of the mock copilot's progress events; tests set it to a few milliseconds. */
export const mockRevisionConfig = { stepMs: 700 };

export type SuggestionTerminalEvent = 'done' | 'failed' | 'cancelled';
interface SuggestionListener {
  (event: SuggestionProgress | { terminal: SuggestionTerminalEvent; data: unknown }): void;
}

class MockDatabase {
  files = new Map<string, FileDto>();
  projects = new Map<string, ProjectRow>();
  sources = new Map<string, Source & { projectId: string }>();
  outlineNodes = new Map<string, OutlineNode & { projectId: string }>();
  comments = new Map<string, Comment>();
  runs = new Map<string, Run>();
  runEvents = new Map<string, RunEvent[]>();
  /** Progress events of mock revisions (the real API persists them in `revision_events`). */
  suggestionEvents = new Map<string, SuggestionProgress[]>();
  private suggestionListeners = new Map<string, Set<SuggestionListener>>();
  runArtifacts = new Map<string, RunArtifact[]>();
  /** Per-user LLM key state behind `GET /auth/me` / `PUT|DELETE /auth/me/llm-key` (never the key itself, like the real API). */
  llmKey: { last4: string; updatedAt: string } | null = null;
  llmKeyConfigurable = true;
  llmKeyPolicy: 'optional' | 'required' = 'optional';
  private runListeners = new Map<string, Set<RunEventListener>>();

  reset(): void {
    this.files.clear();
    this.projects.clear();
    this.sources.clear();
    this.outlineNodes.clear();
    this.comments.clear();
    this.runs.clear();
    this.runEvents.clear();
    this.suggestionEvents.clear();
    this.suggestionListeners.clear();
    this.runArtifacts.clear();
    this.runListeners.clear();
    this.llmKey = null;
    this.llmKeyConfigurable = true;
    this.llmKeyPolicy = 'optional';
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

  /** The badge counts the real API derives from `node_comments` (`openCommentCount`, `pendingSuggestionCount`). */
  withCommentCounts<T extends OutlineNode>(node: T): T {
    let open = 0;
    let pending = 0;
    for (const comment of this.comments.values()) {
      if (comment.nodeId !== node.id) continue;
      if (
        comment.kind === 'comment' &&
        comment.parentId === null &&
        (comment.status === 'open' || comment.status === 'orphaned')
      )
        open += 1;
      if (
        comment.kind === 'suggestion' &&
        (comment.status === 'running' || comment.status === 'pending')
      )
        pending += 1;
    }
    return { ...node, openCommentCount: open, pendingSuggestionCount: pending };
  }

  outlineFlatForProject(projectId: string): OutlineNode[] {
    return [...this.outlineNodes.values()]
      .filter((node) => node.projectId === projectId)
      .map(stripProjectId)
      .map((node) => this.withCommentCounts(node))
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

  onSuggestionEvent(suggestionId: string, listener: SuggestionListener): () => void {
    const listeners = this.suggestionListeners.get(suggestionId) ?? new Set();
    listeners.add(listener);
    this.suggestionListeners.set(suggestionId, listeners);
    return () => listeners.delete(listener);
  }

  publishSuggestionProgress(
    suggestionId: string,
    stage: string,
    message: string,
    payload: Record<string, unknown> = {},
    level = 'info',
  ): void {
    const events = this.suggestionEvents.get(suggestionId) ?? [];
    const event: SuggestionProgress = {
      seq: events.length + 1,
      ts: this.now(),
      stage,
      level,
      message,
      payload,
    };
    events.push(event);
    this.suggestionEvents.set(suggestionId, events);
    for (const listener of this.suggestionListeners.get(suggestionId) ?? []) listener(event);
  }

  publishSuggestionTerminal(
    suggestionId: string,
    terminal: SuggestionTerminalEvent,
    data: unknown,
  ): void {
    for (const listener of this.suggestionListeners.get(suggestionId) ?? [])
      listener({ terminal, data });
  }

  nextSeq(runId: string): number {
    return (this.runEvents.get(runId) ?? []).length + 1;
  }
}

export const db = new MockDatabase();
