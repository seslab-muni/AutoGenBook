import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import { apiClient, unwrap } from '@/api/client';
import type {
  OutlineNode,
  OutlineNodeCreate,
  OutlineNodeTree,
  OutlineNodeUpdate,
  OutlineTreeReplace,
  Page,
} from '@/api/types';

import { projectKeys } from './keys';

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

/** On success: invalidates every outline view for the project. */
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.outline(projectId) });
    },
  });
}

/** On success: updates the node's own cache entry and invalidates the flat/tree list views. */
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
    onSuccess: (node) => {
      queryClient.setQueryData(projectKeys.outlineNode(projectId, nodeId), node);
      void queryClient.invalidateQueries({ queryKey: projectKeys.outlineList(projectId, 'flat') });
      void queryClient.invalidateQueries({ queryKey: projectKeys.outlineList(projectId, 'tree') });
    },
  });
}

/** On success: invalidates every outline view for the project (the deleted node's subtree is gone). */
export function useDeleteOutlineNodeMutation(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (nodeId: string) =>
      unwrap(
        apiClient.DELETE('/api/v1/projects/{projectId}/outline/{nodeId}', {
          params: { path: { projectId, nodeId } },
        }),
      ),
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
