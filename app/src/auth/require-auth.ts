import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';

import { ApiError } from '@/api/client';
import { auth } from '@/api/queries/auth';

import type { Session } from './session';

/**
 * `beforeLoad` guard for routes that require a session. The session cookie is httpOnly, so the
 * only way to know whether one exists is to ask the server — `queryClient.ensureQueryData`
 * dedupes this against whatever else is already fetching `auth.me()` and caches the result for
 * the rest of the route tree (e.g. `AppHeader`'s user menu) to read without another round trip.
 * A 401 means "no session": redirect to `/login?redirect=<current path>`. Any other failure
 * (network error, 5xx) is rethrown for the nearest route `errorComponent`.
 */
export async function requireAuth({
  location,
  context,
}: {
  location: { href: string };
  context: { queryClient: QueryClient };
}): Promise<{ session: Session }> {
  try {
    const user = await context.queryClient.ensureQueryData(auth.me());
    return { session: { userId: user.id, email: user.email, displayName: user.displayName } };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
    throw error;
  }
}
