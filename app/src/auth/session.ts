/**
 * Auth is not designed yet (backend issue #4 keeps a nullable `owner_id` and
 * `current_owner()` returning `None`). This is the single place the rest of
 * the app asks for identity/credentials, so wiring up real auth later only
 * touches this file (and `require-auth.ts`).
 */
export interface Session {
  userId: string;
  displayName: string;
}

const ANONYMOUS_SESSION: Session = { userId: 'anonymous', displayName: 'Anonymous' };

/** Stub: always returns the anonymous session today, so `requireAuth` never redirects. */
export function getSession(): Session | null {
  return ANONYMOUS_SESSION;
}

export function getAuthHeaders(): Record<string, string> {
  return {};
}

/** Stub: no session to tear down until real auth lands. */
export function signOut(): void {}
