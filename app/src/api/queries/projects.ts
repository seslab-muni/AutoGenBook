import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import { apiClient, unwrap } from '@/api/client';
import type { Project, ProjectCreate, ProjectUpdate } from '@/api/types';

import { projectKeys } from './keys';

export const projects = {
  list: (params: { limit?: number; offset?: number } = {}) =>
    queryOptions({
      queryKey: projectKeys.list(params),
      queryFn: () => unwrap(apiClient.GET('/api/v1/projects', { params: { query: params } })),
    }),

  detail: (projectId: string) =>
    queryOptions({
      queryKey: projectKeys.detail(projectId),
      queryFn: () =>
        unwrap(apiClient.GET('/api/v1/projects/{projectId}', { params: { path: { projectId } } })),
    }),
};

/** On success: invalidates `projectKeys.lists()` so the new project appears in every list view. */
export function useCreateProjectMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ProjectCreate) => unwrap(apiClient.POST('/api/v1/projects', { body })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
    },
  });
}

/** On success: updates `projectKeys.detail(projectId)`'s cache directly and invalidates `projectKeys.lists()`. */
export function useUpdateProjectMutation(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ProjectUpdate) =>
      unwrap(
        apiClient.PATCH('/api/v1/projects/{projectId}', { params: { path: { projectId } }, body }),
      ),
    onSuccess: (project: Project) => {
      queryClient.setQueryData(projectKeys.detail(projectId), project);
      void queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
    },
  });
}

/** On success: removes `projectKeys.detail(projectId)` from the cache and invalidates `projectKeys.lists()`. */
export function useDeleteProjectMutation(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      unwrap(apiClient.DELETE('/api/v1/projects/{projectId}', { params: { path: { projectId } } })),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: projectKeys.detail(projectId) });
      void queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
    },
  });
}

/** On success: invalidates `projectKeys.lists()` so the duplicate appears in list views. */
export function useDuplicateProjectMutation(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      unwrap(
        apiClient.POST('/api/v1/projects/{projectId}/duplicate', {
          params: { path: { projectId } },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
    },
  });
}
