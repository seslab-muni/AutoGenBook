import { MutationCache, QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { ApiError } from '@/api/client';
import { reportError } from '@/lib/report-error';

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
        // 5xx/network failures propagate to the nearest route errorComponent (root's
        // `ErrorView`, see `routes/__root.tsx`) only when there's no cached data to fall
        // back on - same rule as `useSuspenseQuery`'s own default. Without the
        // `query.state.data === undefined` guard, a single rate-limited (or otherwise
        // transient) background refetch on an already-rendered page - e.g. the burst of
        // refetches a multi-file source upload used to cause, issue #106 - would unmount
        // the whole visible view instead of leaving the still-good cached data on screen.
        // 4xx errors are always left for the calling component to handle inline.
        throwOnError: (error, query) => !isClientError(error) && query.state.data === undefined,
      },
    },
    mutationCache: new MutationCache({
      onError: (error) => {
        const problem = error instanceof ApiError ? error.problem : undefined;
        toast.error(problem?.title ?? 'Something went wrong', { description: problem?.detail });
        reportError(error, { source: 'mutationCache' });
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
