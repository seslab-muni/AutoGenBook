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
