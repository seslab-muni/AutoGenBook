/**
 * Hierarchical query keys so `invalidateQueries({ queryKey: projectKeys.detail(id) })`
 * cascades to every nested query (sources, outline, runs) for that project.
 */
export const projectKeys = {
  all: ['projects'] as const,
  lists: () => [...projectKeys.all, 'list'] as const,
  list: (params?: { limit?: number; offset?: number }) =>
    [...projectKeys.lists(), params ?? {}] as const,
  details: () => [...projectKeys.all, 'detail'] as const,
  detail: (projectId: string) => [...projectKeys.details(), projectId] as const,
  sources: (projectId: string) => [...projectKeys.detail(projectId), 'sources'] as const,
  source: (projectId: string, sourceId: string) =>
    [...projectKeys.sources(projectId), sourceId] as const,
  outline: (projectId: string) => [...projectKeys.detail(projectId), 'outline'] as const,
  outlineList: (projectId: string, format: 'flat' | 'tree') =>
    [...projectKeys.outline(projectId), format] as const,
  outlineNode: (projectId: string, nodeId: string) =>
    [...projectKeys.outline(projectId), 'node', nodeId] as const,
  runs: (projectId: string) => [...projectKeys.detail(projectId), 'runs'] as const,
};

export const runKeys = {
  all: ['runs'] as const,
  detail: (runId: string) => [...runKeys.all, runId] as const,
  events: (runId: string) => [...runKeys.detail(runId), 'events'] as const,
  artifacts: (runId: string) => [...runKeys.detail(runId), 'artifacts'] as const,
};

export const fileKeys = {
  all: ['files'] as const,
  list: (params?: { limit?: number; offset?: number }) =>
    [...fileKeys.all, 'list', params ?? {}] as const,
  detail: (fileId: string) => [...fileKeys.all, fileId] as const,
};
