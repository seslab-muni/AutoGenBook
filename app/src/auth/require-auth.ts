import { redirect } from '@tanstack/react-router';

import { getSession, type Session } from './session';

/**
 * `beforeLoad` guard for routes that require a session. Redirects to
 * `/login?redirect=<current path>` when `getSession()` is null — which never
 * happens today (see `session.ts`), but this is where the real check goes
 * once auth lands, without touching any route module.
 */
export function requireAuth({ location }: { location: { href: string } }): { session: Session } {
  const session = getSession();
  if (!session) {
    throw redirect({ to: '/login', search: { redirect: location.href } });
  }
  return { session };
}
