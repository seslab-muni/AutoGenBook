import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import { apiClient, unwrap } from '@/api/client';
import type { ExportRequest, Run, RunOptions } from '@/api/types';

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

/**
 * Optimistically sets the run's cached `status` to `cancelled` (issue #21's `ConfirmDialog`
 * flow reads this back immediately rather than waiting on the response); rolls back on error
 * (e.g. a 409 because the run had already reached a terminal state). On success: syncs the
 * cache with the server's copy and invalidates the project's run list so `useActiveRun`
 * (which derives the active run from that list) stops treating this run as active right away,
 * rather than waiting for its next poll.
 */
export function useCancelRunMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      unwrap(apiClient.POST('/api/v1/runs/{runId}/cancel', { params: { path: { runId } } })),
    onMutate: async (runId) => {
      await queryClient.cancelQueries({ queryKey: runKeys.detail(runId) });
      const previous = queryClient.getQueryData<Run>(runKeys.detail(runId));
      if (previous) {
        queryClient.setQueryData<Run>(runKeys.detail(runId), { ...previous, status: 'cancelled' });
      }
      return { previous };
    },
    onError: (_error, runId, context) => {
      if (context?.previous) queryClient.setQueryData(runKeys.detail(runId), context.previous);
    },
    onSuccess: (run) => {
      queryClient.setQueryData(runKeys.detail(run.id), run);
      void queryClient.invalidateQueries({ queryKey: projectKeys.runs(run.projectId) });
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
