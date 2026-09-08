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

/**
 * The app's single `QueryClient` instance, used both by `AppProviders` (so React renders off
 * it) and by cross-cutting modules outside the React tree — `src/auth/session.ts`'s `signOut`
 * and `src/api/client.ts`'s 401 response middleware — that need to clear cached auth state from
 * outside any component. Tests never import this: `renderRouterApp`/`renderWithQueryClient`
 * build their own isolated `QueryClient` per test via `createQueryClient()`.
 */
export const queryClient: QueryClient = createQueryClient();
