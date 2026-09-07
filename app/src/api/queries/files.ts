import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import { apiClient, unwrap } from '@/api/client';
import { uploadFile, type UploadOptions } from '@/api/upload';

import { fileKeys } from './keys';

export const files = {
  list: (params: { limit?: number; offset?: number } = {}) =>
    queryOptions({
      queryKey: fileKeys.list(params),
      queryFn: () => unwrap(apiClient.GET('/api/v1/files', { params: { query: params } })),
    }),

  detail: (fileId: string) =>
    queryOptions({
      queryKey: fileKeys.detail(fileId),
      queryFn: () =>
        unwrap(apiClient.GET('/api/v1/files/{fileId}', { params: { path: { fileId } } })),
    }),
};

/** On success: invalidates `fileKeys.all` so the new file shows up in list views. */
export function useUploadFileMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: { file: File } & UploadOptions) =>
      uploadFile(variables.file, variables),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: fileKeys.all });
    },
  });
}

/** On success: removes the file's cache entry and invalidates `fileKeys.all`. */
export function useDeleteFileMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) =>
      unwrap(apiClient.DELETE('/api/v1/files/{fileId}', { params: { path: { fileId } } })),
    onSuccess: (_data, fileId) => {
      queryClient.removeQueries({ queryKey: fileKeys.detail(fileId) });
      void queryClient.invalidateQueries({ queryKey: fileKeys.all });
    },
  });
}
