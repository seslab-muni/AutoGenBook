import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor, type RenderHookResult } from '@testing-library/react';
import type { ReactNode } from 'react';

/** Renders a hook (a `useQuery`/`useMutation` call) against a fresh, retry-free `QueryClient`. */
export function renderWithQueryClient<Result, Props>(
  callback: (props: Props) => Result,
): RenderHookResult<Result, Props> & { queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  const result = renderHook(callback, { wrapper });
  return { ...result, queryClient };
}

export { waitFor };
