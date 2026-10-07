import { useQuery } from '@tanstack/react-query';

import { sources as sourcesQueries } from '@/api/queries/sources';
import type { OutlineNode, Source } from '@/api/types';
import { resolveSourceScope, type EffectiveSourceScope } from '@/features/outline/source-scope';

/**
 * The project sources a section effectively retrieves from: its resolved scope (own selection,
 * the nearest scoped ancestor's, or every project source) and the matching `Source` rows. Shares
 * the project source list's cache entry with `useNodeSourceScope` and `SourcesDialog`.
 */
export function useEffectiveSources(
  projectId: string,
  nodeId: string,
  flat: readonly OutlineNode[],
): { scope: EffectiveSourceScope; sources: Source[]; scopeFrom: OutlineNode | undefined } {
  const { data } = useQuery(sourcesQueries.list(projectId));
  const scope = resolveSourceScope(nodeId, flat);
  const scopeFrom = scope.fromNodeId
    ? flat.find((item) => item.id === scope.fromNodeId)
    : undefined;
  const all = data?.items ?? [];
  const wanted = scope.kind === 'selected' ? new Set(scope.sourceIds) : null;
  const sources = wanted ? all.filter((source) => wanted.has(source.id)) : all;
  return { scope, sources, scopeFrom };
}
