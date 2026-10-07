import { useQueries, useQuery } from '@tanstack/react-query';

import { sources as sourcesQueries } from '@/api/queries/sources';
import type { OutlineNode, Source } from '@/api/types';
import { resolveSourceScope, type EffectiveSourceScope } from '@/features/outline/source-scope';

/** The API's maximum page size, used for every page after the shared first one. */
const MAX_PAGE = 200;

export interface EffectiveSources {
  scope: EffectiveSourceScope;
  /** Sources the section can retrieve from (in scope and not failed). */
  sources: Source[];
  /** In-scope sources whose indexing failed; they are never searched. */
  failedSources: Source[];
  /** True until the whole project source list has been fetched. */
  loading: boolean;
  scopeFrom: OutlineNode | undefined;
}

/**
 * The project sources a section effectively retrieves from: its resolved scope (own selection,
 * the nearest scoped ancestor's, or every project source) and the matching `Source` rows. Shares
 * the project source list's cache entry with `useNodeSourceScope` and `SourcesDialog`, and pages
 * through the rest when the project has more sources than the first page holds.
 */
export function useEffectiveSources(
  projectId: string,
  nodeId: string,
  flat: readonly OutlineNode[],
): EffectiveSources {
  const first = useQuery(sourcesQueries.list(projectId));
  const total = first.data?.total ?? 0;
  const firstCount = first.data?.items.length ?? 0;
  const extraOffsets: number[] = [];
  // `firstCount > 0` guards against looping forever on a server that returns an empty first page.
  for (let offset = firstCount; offset < total; offset += MAX_PAGE) extraOffsets.push(offset);
  const extra = useQueries({
    queries: extraOffsets.map((offset) =>
      sourcesQueries.list(projectId, { limit: MAX_PAGE, offset }),
    ),
  });

  const scope = resolveSourceScope(nodeId, flat);
  const scopeFrom = scope.fromNodeId
    ? flat.find((item) => item.id === scope.fromNodeId)
    : undefined;
  const all = [...(first.data?.items ?? []), ...extra.flatMap((query) => query.data?.items ?? [])];
  const wanted = scope.kind === 'selected' ? new Set(scope.sourceIds) : null;
  const inScope = wanted ? all.filter((source) => wanted.has(source.id)) : all;

  return {
    scope,
    sources: inScope.filter((source) => source.status !== 'error'),
    failedSources: inScope.filter((source) => source.status === 'error'),
    loading: first.isPending || extra.some((query) => query.isPending),
    scopeFrom,
  };
}
