import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import { apiClient, unwrap } from '@/api/client';
import type { SourceCreate, SourceUpdate } from '@/api/types';

import { projectKeys } from './keys';

export const sources = {
  list: (projectId: string, params: { limit?: number; offset?: number } = {}) =>
    queryOptions({
      queryKey: [...projectKeys.sources(projectId), params],
      queryFn: () =>
        unwrap(
          apiClient.GET('/api/v1/projects/{projectId}/sources', {
            params: { path: { projectId }, query: params },
          }),
        ),
    }),

  detail: (projectId: string, sourceId: string) =>
    queryOptions({
      queryKey: projectKeys.source(projectId, sourceId),
      queryFn: () =>
        unwrap(
          apiClient.GET('/api/v1/projects/{projectId}/sources/{sourceId}', {
            params: { path: { projectId, sourceId } },
          }),
        ),
    }),
};

/** On success: invalidates `projectKeys.sources(projectId)` and `projectKeys.detail(projectId)` (its embedded `sourcesCount`). */
export function useAddSourceMutation(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SourceCreate) =>
      unwrap(
        apiClient.POST('/api/v1/projects/{projectId}/sources', {
          params: { path: { projectId } },
          body,
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.sources(projectId) });
      void queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
    },
  });
}

/** On success: updates the source's own cache entry and invalidates the project's source list. */
export function useUpdateSourceMutation(projectId: string, sourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SourceUpdate) =>
      unwrap(
        apiClient.PATCH('/api/v1/projects/{projectId}/sources/{sourceId}', {
          params: { path: { projectId, sourceId } },
          body,
        }),
      ),
    onSuccess: (source) => {
      queryClient.setQueryData(projectKeys.source(projectId, sourceId), source);
      void queryClient.invalidateQueries({ queryKey: projectKeys.sources(projectId) });
    },
  });
}

/** On success: invalidates `projectKeys.sources(projectId)` and `projectKeys.detail(projectId)`. */
export function useRemoveSourceMutation(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) =>
      unwrap(
        apiClient.DELETE('/api/v1/projects/{projectId}/sources/{sourceId}', {
          params: { path: { projectId, sourceId } },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.sources(projectId) });
      void queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
    },
  });
}
