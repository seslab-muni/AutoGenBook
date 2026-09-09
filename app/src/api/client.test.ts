import { waitFor } from '@testing-library/react';
import { http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { problemResponse } from '@/mocks/problem';
import { server } from '@/mocks/server';
import { queryClient } from '@/app/query-client';
import { router } from '@/app/router';

import { apiClient, unwrap } from './client';
import { authKeys } from './queries/keys';

describe('apiClient 401 response middleware', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears the cached session and redirects to /login on a 401 from an ordinary endpoint', async () => {
    queryClient.setQueryData(authKeys.me(), {
      id: 'u1',
      email: 'a@example.com',
      displayName: 'A',
    });
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(undefined);
    server.use(
      http.get('*/api/v1/projects', () =>
        problemResponse(401, 'Not authenticated', '/api/v1/projects'),
      ),
    );

    await expect(unwrap(apiClient.GET('/api/v1/projects', {}))).rejects.toThrow();

    // The 401 handler navigates first and only removes the cached session afterward (a dynamic
    // `import('@/app/router')` plus a `.then()` chain — see client.ts's responseMiddleware for
    // why), so both effects land asynchronously rather than immediately after the rejection.
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          to: '/login',
          search: expect.objectContaining({ redirect: expect.any(String) }),
        }),
      );
    });
    await waitFor(() => {
      expect(queryClient.getQueryData(authKeys.me())).toBeUndefined();
    });
  });

  it('does not redirect for a 401 from /auth/login itself (that is a normal invalid-credentials response)', async () => {
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(undefined);
    server.use(
      http.post('*/api/v1/auth/login', () =>
        problemResponse(401, 'Invalid email or password', '/api/v1/auth/login'),
      ),
    );

    await expect(
      unwrap(
        apiClient.POST('/api/v1/auth/login', {
          body: { email: 'a@example.com', password: 'wrong' },
        }),
      ),
    ).rejects.toThrow();

    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('does not redirect for a 401 from auth.me() while already on /login', async () => {
    // `login.tsx`'s own `beforeLoad` calls `ensureQueryData(auth.me())` to check for an existing
    // session, and a 401 there is the normal "not logged in" outcome it already handles inline.
    // Without this guard, that expected 401 would still trip this middleware (it only excludes
    // the login *endpoint*, not the `me` probe) and navigate to `/login` again with a `redirect`
    // built from the current (already `/login`) URL — re-running `beforeLoad`, 401ing again, and
    // redirecting again, each hop nesting the previous URL inside `redirect` forever.
    window.history.pushState({}, '', '/login?redirect=%2Fp%2Fabc');
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(undefined);
    server.use(
      http.get('*/api/v1/auth/me', () => problemResponse(401, 'Not authenticated', '/api/v1/auth/me')),
    );

    await expect(unwrap(apiClient.GET('/api/v1/auth/me', {}))).rejects.toThrow();

    expect(navigateSpy).not.toHaveBeenCalled();
  });
});
