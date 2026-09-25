import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';

import { ApiError } from '@/api/client';
import { useUpdateOutlineNodeMutation } from '@/api/queries/outline';
import { sources as sourcesQueries } from '@/api/queries/sources';
import type { OutlineNode, OutlineNodeUpdate, Source, SourceScope } from '@/api/types';
import type { SourceScopeOption } from '@/features/outline/components/source-scope-control';
import { inheritedSourceScope, resolveSourceScope } from '@/features/outline/source-scope';

function reportError(error: unknown) {
  const problem = error instanceof ApiError ? error.problem : undefined;
  toast.error(problem?.detail ?? problem?.title ?? 'Could not change sources');
}

/**
 * Shared state/actions behind every per-node source-scope control (issue #138) — the node
 * properties sheet's Sources section and the copilot's "Sources for this section" card. Scope
 * PATCHes are immediate (not debounced), and "Only selected" never PATCHes an empty selection:
 * it opens the picker instead, and removing the last source reverts to `inherit`.
 */
export function useNodeSourceScope(
  projectId: string,
  node: OutlineNode,
  flat: readonly OutlineNode[],
) {
  // No params: shares `SourcesDialog`'s cache entry for the project's source list.
  const { data } = useQuery(sourcesQueries.list(projectId));
  const sources = useMemo(() => data?.items ?? [], [data]);
  const sourcesById = useMemo(
    () => new Map(sources.map((source) => [source.id, source])),
    [sources],
  );
  const updateMutation = useUpdateOutlineNodeMutation(projectId, node.id);
  const [pickerOpen, setPickerOpen] = useState(false);

  const effective = resolveSourceScope(node.id, flat);
  const inherited = inheritedSourceScope(node.id, flat);
  const inheritedFrom = inherited.fromNodeId
    ? flat.find((item) => item.id === inherited.fromNodeId)
    : undefined;
  const effectiveFrom = effective.fromNodeId
    ? flat.find((item) => item.id === effective.fromNodeId)
    : undefined;
  const isTopLevel = node.parentId === null;

  // A top-level node that inherits already means "all project sources", so it only gets two
  // choices; a nested one can also defer to its nearest scoped ancestor.
  const options: SourceScopeOption[] = [
    ...(isTopLevel
      ? []
      : [
          {
            value: 'inherit' as const,
            label: inheritedFrom
              ? `Inherit from §${inheritedFrom.sectionNumber}`
              : 'Inherit (all sources)',
          },
        ]),
    { value: 'all', label: 'All project sources' },
    { value: 'selected', label: 'Only selected' },
  ];
  const value: SourceScope =
    isTopLevel && node.sourceScope === 'inherit' ? 'all' : node.sourceScope;

  const effectiveSources: Source[] =
    effective.kind === 'selected'
      ? effective.sourceIds
          .map((id) => sourcesById.get(id))
          .filter((source): source is Source => source !== undefined)
      : [];

  function patch(body: OutlineNodeUpdate, onSuccess?: () => void) {
    updateMutation.mutate(body, {
      onError: reportError,
      ...(onSuccess ? { onSuccess } : {}),
    });
  }

  function choose(next: SourceScope) {
    if (next === value) return;
    if (next === 'selected') {
      setPickerOpen(true);
      return;
    }
    // `inherit` is the canonical "all" for a top-level node — same behavior, and it keeps the
    // node's scope at the backend's default instead of an explicit override.
    patch({ sourceScope: isTopLevel && next === 'all' ? 'inherit' : next });
  }

  function removeSource(sourceId: string) {
    const remaining = node.sourceIds.filter((id) => id !== sourceId);
    patch(
      remaining.length > 0
        ? { sourceScope: 'selected', sourceIds: remaining }
        : { sourceScope: 'inherit' },
    );
  }

  function applySelection(sourceIds: string[]) {
    if (sourceIds.length === 0) return;
    patch({ sourceScope: 'selected', sourceIds }, () => setPickerOpen(false));
  }

  return {
    sources,
    sourcesById,
    effective,
    effectiveFrom,
    effectiveSources,
    inheritedFrom,
    isTopLevel,
    options,
    value,
    choose,
    removeSource,
    clear: () => patch({ sourceScope: 'inherit' }),
    applySelection,
    isPending: updateMutation.isPending,
    pickerOpen,
    setPickerOpen,
    /** What the picker starts with: the node's own selection, else the one it inherits. */
    initialPickerIds:
      node.sourceScope === 'selected' ? node.sourceIds : effectiveSourceIds(effective),
  };
}

function effectiveSourceIds(effective: ReturnType<typeof resolveSourceScope>): string[] {
  return effective.kind === 'selected' ? effective.sourceIds : [];
}
