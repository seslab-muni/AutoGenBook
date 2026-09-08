import { QueryClient } from '@tanstack/react-query';
import { isRedirect } from '@tanstack/react-router';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';

import { MOCK_USER } from '@/mocks/fixtures';
import { problemResponse } from '@/mocks/problem';
import { server } from '@/mocks/server';

import { requireAuth } from './require-auth';

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('requireAuth', () => {
  it('resolves the session from GET /auth/me when a session cookie is present (the default mock state)', async () => {
    const result = await requireAuth({
      location: { href: '/p/some-project' },
      context: { queryClient: newQueryClient() },
    });

    expect(result.session).toEqual({
      userId: MOCK_USER.id,
      email: MOCK_USER.email,
      displayName: MOCK_USER.displayName,
    });
  });

  it('redirects to /login with the current path when GET /auth/me returns 401', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => problemResponse(401, 'Not authenticated', '/api/v1/auth/me')),
    );

    let thrown: unknown;
    try {
      await requireAuth({
        location: { href: '/p/some-project?node=abc' },
        context: { queryClient: newQueryClient() },
      });
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

  it('rethrows a non-401 failure (e.g. a 500) instead of redirecting', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => problemResponse(500, 'Simulated failure', '/api/v1/auth/me')),
    );

    await expect(
      requireAuth({
        location: { href: '/p/some-project' },
        context: { queryClient: newQueryClient() },
      }),
    ).rejects.toThrow();
  });
});
