import { useRef } from 'react';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import { apiClient, unwrap } from '@/api/client';
import type { SourceCreate, SourceUpdate } from '@/api/types';

import { projectKeys } from './keys';

/** Multi-file uploads in `SourcesDialog` fire one `useAddSourceMutation` success per file within
 * the same second; invalidating on every single one caused a refetch burst that tripped nginx's
 * request-rate limit (issue #106). Debouncing collapses a whole upload batch into one refetch. */
const INVALIDATE_DEBOUNCE_MS = 500;

export const sources = {
  list: (projectId: string, params: { limit?: number; offset?: number } = {}) =>
    queryOptions({
      queryKey: [...projectKeys.sources(projectId), params],
      queryFn: () =>
        unwrap(
          apiClient.GET('/api/v1/projects/{project_id}/sources', {
            params: { path: { project_id: projectId }, query: params },
          }),
        ),
    }),

  detail: (projectId: string, sourceId: string) =>
    queryOptions({
      queryKey: projectKeys.source(projectId, sourceId),
      queryFn: () =>
        unwrap(
          apiClient.GET('/api/v1/projects/{project_id}/sources/{source_id}', {
            params: { path: { project_id: projectId, source_id: sourceId } },
          }),
        ),
    }),
};

/** On success: invalidates `projectKeys.sources(projectId)` and `projectKeys.detail(projectId)`
 * (its embedded `sourcesCount`), debounced so a batch of near-simultaneous successes (a multi-file
 * upload) collapses into one refetch instead of one per file (issue #106). */
export function useAddSourceMutation(projectId: string) {
  const queryClient = useQueryClient();
  const invalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useMutation({
    mutationFn: (body: SourceCreate) =>
      unwrap(
        apiClient.POST('/api/v1/projects/{project_id}/sources', {
          params: { path: { project_id: projectId } },
          body,
        }),
      ),
    onSuccess: () => {
      if (invalidateTimer.current) clearTimeout(invalidateTimer.current);
      invalidateTimer.current = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: projectKeys.sources(projectId) });
        void queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
      }, INVALIDATE_DEBOUNCE_MS);
    },
  });
}

/** On success: updates the source's own cache entry and invalidates the project's source list. */
export function useUpdateSourceMutation(projectId: string, sourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SourceUpdate) =>
      unwrap(
        apiClient.PATCH('/api/v1/projects/{project_id}/sources/{source_id}', {
          params: { path: { project_id: projectId, source_id: sourceId } },
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
        apiClient.DELETE('/api/v1/projects/{project_id}/sources/{source_id}', {
          params: { path: { project_id: projectId, source_id: sourceId } },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.sources(projectId) });
      void queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
    },
  });
}
