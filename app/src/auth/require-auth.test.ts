import { isRedirect } from '@tanstack/react-router';
import { describe, expect, it, vi } from 'vitest';

import { requireAuth } from './require-auth';
import * as session from './session';

describe('requireAuth', () => {
  it('lets the navigation through when a session exists (today: always)', () => {
    const result = requireAuth({ location: { href: '/p/some-project' } });

    expect(result.session).not.toBeNull();
  });

  it('redirects to /login with the current path when there is no session', () => {
    vi.spyOn(session, 'getSession').mockReturnValueOnce(null);

    let thrown: unknown;
    try {
      requireAuth({ location: { href: '/p/some-project?node=abc' } });
    } catch (error) {
      thrown = error;
    }

    expect(isRedirect(thrown)).toBe(true);
    const redirectResponse = thrown as Response & {
      options: { to: string; search: { redirect: string } };
    };
    expect(redirectResponse.options.to).toBe('/login');
    expect(redirectResponse.options.search).toEqual({ redirect: '/p/some-project?node=abc' });
  });
});
