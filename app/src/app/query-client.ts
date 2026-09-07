import { MutationCache, QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { ApiError } from '@/api/client';

function isClientError(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // 4xx responses won't succeed on retry (bad request, not found, ...); anything
        // else (network errors, 5xx) gets one retry.
        retry: (failureCount, error) => !isClientError(error) && failureCount < 1,
        // 5xx/network failures propagate to the nearest route errorComponent; 4xx
        // errors are left for the calling component to handle inline.
        throwOnError: (error) => !isClientError(error),
      },
    },
    mutationCache: new MutationCache({
      onError: (error) => {
        const problem = error instanceof ApiError ? error.problem : undefined;
        toast.error(problem?.title ?? 'Something went wrong', { description: problem?.detail });
      },
    }),
  });
}
