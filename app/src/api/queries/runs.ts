import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import { apiClient, unwrap } from '@/api/client';
import type { ExportRequest, RunOptions } from '@/api/types';

import { projectKeys, runKeys } from './keys';

export const runs = {
  list: (projectId: string, params: { limit?: number; offset?: number } = {}) =>
    queryOptions({
      queryKey: [...projectKeys.runs(projectId), params],
      queryFn: () =>
        unwrap(
          apiClient.GET('/api/v1/projects/{projectId}/runs', {
            params: { path: { projectId }, query: params },
          }),
        ),
    }),

  detail: (runId: string) =>
    queryOptions({
      queryKey: runKeys.detail(runId),
      queryFn: () => unwrap(apiClient.GET('/api/v1/runs/{runId}', { params: { path: { runId } } })),
    }),

  events: (runId: string, params: { afterSeq?: number; limit?: number } = {}) =>
    queryOptions({
      queryKey: [...runKeys.events(runId), params],
      queryFn: () =>
        unwrap(
          apiClient.GET('/api/v1/runs/{runId}/events', {
            params: { path: { runId }, query: params },
          }),
        ),
    }),

  artifacts: (runId: string, params: { limit?: number; offset?: number } = {}) =>
    queryOptions({
      queryKey: [...runKeys.artifacts(runId), params],
      queryFn: () =>
        unwrap(
          apiClient.GET('/api/v1/runs/{runId}/artifacts', {
            params: { path: { runId }, query: params },
          }),
        ),
    }),
};

/** On success: invalidates the project's run list and detail (its `lastRunId`/`resumable` change once a run starts). */
export function useCreateRunMutation(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body?: RunOptions) =>
      unwrap(
        apiClient.POST('/api/v1/projects/{projectId}/runs', {
          params: { path: { projectId } },
          body,
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.runs(projectId) });
      void queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
    },
  });
}

/** On success: updates the run's own cache entry (now `cancelled` or `cancelRequested`). */
export function useCancelRunMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      unwrap(apiClient.POST('/api/v1/runs/{runId}/cancel', { params: { path: { runId } } })),
    onSuccess: (run) => {
      queryClient.setQueryData(runKeys.detail(run.id), run);
    },
  });
}

/** On success: invalidates the base run's artifact list and its project's run list (the new export run appears there). */
export function useExportRunMutation(runId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ExportRequest) =>
      unwrap(apiClient.POST('/api/v1/runs/{runId}/exports', { params: { path: { runId } }, body })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: runKeys.artifacts(runId) });
      void queryClient.invalidateQueries({ queryKey: projectKeys.runs(projectId) });
    },
  });
}
