import { queryOptions, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { apiClient, unwrap } from '@/api/client';
import type {
  OutlineNode,
  OutlineNodeCreate,
  OutlineNodeTree,
  OutlineNodeUpdate,
  OutlineTreeReplace,
  Page,
} from '@/api/types';
import { assignPositions, descendantIds, nextOrderIndex } from '@/features/outline/model';

import { projectKeys } from './keys';

type OutlineFlatSnapshot = [readonly unknown[], Page<OutlineNode> | undefined][];

/** Snapshots every cached `outline.flat` page for `projectId` (any `{limit,offset}` params) for rollback. */
function snapshotFlat(queryClient: QueryClient, projectId: string): OutlineFlatSnapshot {
  return queryClient.getQueriesData<Page<OutlineNode>>({
    queryKey: projectKeys.outlineList(projectId, 'flat'),
  });
}

function restoreFlat(queryClient: QueryClient, snapshot: OutlineFlatSnapshot): void {
  for (const [key, data] of snapshot) {
    queryClient.setQueryData(key, data);
  }
}

/** Applies `updateItems` to every cached `outline.flat` page for `projectId`, re-deriving positions. */
function patchFlat(
  queryClient: QueryClient,
  projectId: string,
  updateItems: (items: OutlineNode[]) => OutlineNode[],
): void {
  queryClient.setQueriesData<Page<OutlineNode>>(
    { queryKey: projectKeys.outlineList(projectId, 'flat') },
    (page) => {
      if (!page) return page;
      const items = assignPositions(updateItems(page.items));
      return { ...page, items, total: items.length };
    },
  );
}

function wordCount(markdown: string): number {
  return markdown.trim().length === 0 ? 0 : markdown.trim().split(/\s+/).length;
}

export const outline = {
  /** `format=flat` — the canonical shape, one row per node addressed by `parentId`/`orderIndex`. */
  flat: (projectId: string, params: { limit?: number; offset?: number } = {}) =>
    queryOptions({
      queryKey: [...projectKeys.outlineList(projectId, 'flat'), params],
      queryFn: async () => {
        const page = await unwrap(
          apiClient.GET('/api/v1/projects/{projectId}/outline', {
            params: { path: { projectId }, query: { ...params, format: 'flat' } },
          }),
        );
        // The spec types this endpoint's response as a `PageOfOutlineNode | PageOfOutlineNodeTree`
        // union since `format` is a runtime query param TS can't narrow by; we just requested `flat`.
        return page as Page<OutlineNode>;
      },
    }),

  /** `format=tree` — root-level nodes nested with `children`, a rendering convenience over the same rows. */
  tree: (projectId: string, params: { limit?: number; offset?: number } = {}) =>
    queryOptions({
      queryKey: [...projectKeys.outlineList(projectId, 'tree'), params],
      queryFn: async () => {
        const page = await unwrap(
          apiClient.GET('/api/v1/projects/{projectId}/outline', {
            params: { path: { projectId }, query: { ...params, format: 'tree' } },
          }),
        );
        return page as Page<OutlineNodeTree>;
      },
    }),

  node: (projectId: string, nodeId: string) =>
    queryOptions({
      queryKey: projectKeys.outlineNode(projectId, nodeId),
      queryFn: () =>
        unwrap(
          apiClient.GET('/api/v1/projects/{projectId}/outline/{nodeId}', {
            params: { path: { projectId, nodeId } },
          }),
        ),
    }),
};

/** On success: invalidates every outline view (`projectKeys.outline(projectId)`) and the project detail (embedded tree). */
export function useReplaceOutlineMutation(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: OutlineTreeReplace) =>
      unwrap(
        apiClient.PUT('/api/v1/projects/{projectId}/outline', {
          params: { path: { projectId } },
          body,
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.outline(projectId) });
      void queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
    },
  });
}

/**
 * Optimistically inserts a placeholder row (temp id `optimistic-<uuid>`) at
 * `nextOrderIndex`, so the tree updates before the server responds; rolls
 * back on error. On success, invalidates so the placeholder is replaced by
 * the server's real row (real id, `wordBudget`, etc).
 */
export function useCreateOutlineNodeMutation(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: OutlineNodeCreate) =>
      unwrap(
        apiClient.POST('/api/v1/projects/{projectId}/outline', {
          params: { path: { projectId } },
          body,
        }),
      ),
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: projectKeys.outlineList(projectId, 'flat') });
      const previous = snapshotFlat(queryClient, projectId);
      patchFlat(queryClient, projectId, (items) => {
        const targetPages = body.targetPages ?? 1;
        const optimistic: OutlineNode = {
          id: `optimistic-${crypto.randomUUID()}`,
          parentId: body.parentId,
          orderIndex: body.orderIndex ?? nextOrderIndex(body.parentId, items),
          cliKey: null,
          title: body.title,
          summary: body.summary ?? '',
          level: 0,
          sectionNumber: '',
          status: 'not_started',
          targetPages,
          wordBudget: Math.round(targetPages * 350),
          actualWords: 0,
          equationDensityLevel: body.equationDensityLevel ?? 3,
          mathLevel: body.mathLevel ?? 'rigorous',
          subPrompt: body.subPrompt ?? null,
          contentMarkdown: '',
          contentLatex: '',
          ragCitations: [],
          reviewerScore: null,
          reviewerNotes: null,
          structureLocked: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        return [...items, optimistic];
      });
      return { previous };
    },
    onError: (_error, _body, context) => {
      if (context) restoreFlat(queryClient, context.previous);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.outline(projectId) });
    },
  });
}

/**
 * Optimistically merges the patch into the node's row (and, when
 * `parentId`/`orderIndex` change, re-derives sibling order the way
 * `OutlineService.update` does — new-parent siblings renumbered
 * contiguously with the moved node inserted at its requested position);
 * rolls back on error. On success: updates the node's own cache entry and
 * invalidates the flat/tree list views.
 */
export function useUpdateOutlineNodeMutation(projectId: string, nodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: OutlineNodeUpdate) =>
      unwrap(
        apiClient.PATCH('/api/v1/projects/{projectId}/outline/{nodeId}', {
          params: { path: { projectId, nodeId } },
          body,
        }),
      ),
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: projectKeys.outlineList(projectId, 'flat') });
      const previous = snapshotFlat(queryClient, projectId);
      patchFlat(queryClient, projectId, (items) => {
        const current = items.find((item) => item.id === nodeId);
        if (!current) return items;

        const merged: OutlineNode = {
          ...current,
          ...body,
          actualWords:
            body.contentMarkdown !== undefined
              ? wordCount(body.contentMarkdown)
              : current.actualWords,
          updatedAt: new Date().toISOString(),
        };

        const rest = items.filter((item) => item.id !== nodeId);
        const moving = body.parentId !== undefined || body.orderIndex !== undefined;
        if (!moving) {
          return items.map((item) => (item.id === nodeId ? merged : item));
        }

        const newSiblings = rest
          .filter((item) => item.parentId === merged.parentId)
          .sort((a, b) => a.orderIndex - b.orderIndex);
        const insertAt =
          body.orderIndex !== undefined
            ? Math.max(0, Math.min(body.orderIndex, newSiblings.length))
            : newSiblings.length;
        newSiblings.splice(insertAt, 0, merged);
        const renumbered = new Map(newSiblings.map((item, index) => [item.id, index]));

        return items.map((item) => {
          if (item.id === nodeId) return { ...merged, orderIndex: renumbered.get(nodeId) ?? 0 };
          const newIndex = renumbered.get(item.id);
          return newIndex !== undefined ? { ...item, orderIndex: newIndex } : item;
        });
      });
      return { previous };
    },
    onError: (_error, _body, context) => {
      if (context) restoreFlat(queryClient, context.previous);
    },
    onSuccess: (node) => {
      queryClient.setQueryData(projectKeys.outlineNode(projectId, nodeId), node);
      void queryClient.invalidateQueries({ queryKey: projectKeys.outlineList(projectId, 'flat') });
      void queryClient.invalidateQueries({ queryKey: projectKeys.outlineList(projectId, 'tree') });
    },
  });
}

/**
 * Optimistically removes the node and every descendant from `outline.flat`;
 * rolls back on error. On success: invalidates every outline view for the
 * project (the deleted subtree is gone server-side too).
 */
export function useDeleteOutlineNodeMutation(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (nodeId: string) =>
      unwrap(
        apiClient.DELETE('/api/v1/projects/{projectId}/outline/{nodeId}', {
          params: { path: { projectId, nodeId } },
        }),
      ),
    onMutate: async (nodeId) => {
      await queryClient.cancelQueries({ queryKey: projectKeys.outlineList(projectId, 'flat') });
      const previous = snapshotFlat(queryClient, projectId);
      patchFlat(queryClient, projectId, (items) => {
        const removed = descendantIds(nodeId, items);
        removed.add(nodeId);
        return items.filter((item) => !removed.has(item.id));
      });
      return { previous };
    },
    onError: (_error, _nodeId, context) => {
      if (context) restoreFlat(queryClient, context.previous);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.outline(projectId) });
    },
  });
}

/** On success: invalidates the outline (node status flips to `drafting`) and the project's run list. */
export function useRegenerateOutlineNodeMutation(projectId: string, nodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (promptModifier?: string) =>
      unwrap(
        apiClient.POST('/api/v1/projects/{projectId}/outline/{nodeId}/regenerate', {
          params: { path: { projectId, nodeId } },
          body: promptModifier !== undefined ? { promptModifier } : {},
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.outline(projectId) });
      void queryClient.invalidateQueries({ queryKey: projectKeys.runs(projectId) });
    },
  });
}
