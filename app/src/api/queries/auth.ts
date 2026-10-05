import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import { apiClient, unwrap } from '@/api/client';
import type { LoginRequest } from '@/api/types';

import { authKeys } from './keys';

export const auth = {
  /**
   * The cookie set by `POST /auth/login` is httpOnly, so this 200-vs-401 round trip is the only
   * way the app learns whether a session exists — there is no synchronous check. `requireAuth`
   * calls `queryClient.ensureQueryData(auth.me())` in every guarded route's `beforeLoad`; a 401
   * (`ApiError.status === 401`) means "no session" there. `retry: false` keeps that 401 from
   * being retried before the guard gets to see it.
   */
  me: () =>
    queryOptions({
      queryKey: authKeys.me(),
      queryFn: () => unwrap(apiClient.GET('/api/v1/auth/me')),
      retry: false,
    }),
};

/** On success: seeds `auth.me()`'s cache with the logged-in user, so guarded routes see a session immediately. */
export function useLoginMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) => unwrap(apiClient.POST('/api/v1/auth/login', { body })),
    onSuccess: (user) => {
      queryClient.setQueryData(authKeys.me(), user);
    },
  });
}

/**
 * Per-user LLM key: `PUT /auth/me/llm-key` answers with the updated `UserOut`, which is written
 * straight into `auth.me()`'s cache so the account dialog and the start-run gating see it at once.
 * The key itself is only ever in the request body - never cached or echoed back.
 */
export function useSetLlmKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (apiKey: string) =>
      unwrap(apiClient.PUT('/api/v1/auth/me/llm-key', { body: { apiKey } })),
    onSuccess: (user) => {
      queryClient.setQueryData(authKeys.me(), user);
    },
  });
}

/** Per-user LLM key: `DELETE /auth/me/llm-key` has no body, so refetch `auth.me()` to pick up the cleared key. */
export function useClearLlmKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(apiClient.DELETE('/api/v1/auth/me/llm-key')),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: authKeys.me() }),
  });
}

/** On success: drops every cached `auth`-scoped query so the next `auth.me()` read goes to the network. */
export function useLogoutMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(apiClient.POST('/api/v1/auth/logout')),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: authKeys.all });
    },
  });
}
