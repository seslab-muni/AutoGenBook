import { apiClient, unwrap } from '@/api/client';
import { authKeys } from '@/api/queries/keys';
import { queryClient } from '@/app/query-client';
import { router } from '@/app/router';

/**
 * The signed-in user. There is no synchronous "do we have a session" check — the session cookie
 * is httpOnly, so `GET /auth/me` (via `auth.me()` in `@/api/queries/auth`, driven through
 * `requireAuth`'s `beforeLoad`) is the only way to learn whether one exists.
 */
export interface Session {
  userId: string;
  email: string;
  displayName: string;
}

/**
 * Headers every mutating `apiClient`/`uploadFile` request needs. The session itself travels as
 * an httpOnly cookie the browser attaches automatically (same-origin, `SameSite=Lax`) — this is
 * only the CSRF header the backend requires on every non-GET/HEAD/OPTIONS `/api/v1` request.
 */
export function getAuthHeaders(): Record<string, string> {
  return { 'X-Requested-With': 'XMLHttpRequest' };
}

/**
 * Logs the current session out: calls `POST /auth/logout` (best-effort — the cookie is cleared
 * either way once this navigates to `/login`), drops the cached `auth.me()` (and anything else
 * scoped under `authKeys.all`) so no stale "signed in" state lingers, then navigates to
 * `/login`. Not a hook (called from a plain click handler in `AppHeader`'s user menu), so it
 * drives the API call directly rather than through `useLogoutMutation`.
 */
export function signOut(): void {
  void unwrap(apiClient.POST('/api/v1/auth/logout'))
    .catch(() => {
      // Best-effort: even if the request fails (e.g. already logged out elsewhere), the local
      // session cache is cleared and the user is sent to /login regardless.
    })
    .finally(() => {
      queryClient.removeQueries({ queryKey: authKeys.all });
      void router.navigate({ to: '/login' });
    });
}
