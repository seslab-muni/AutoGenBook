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

    expect(queryClient.getQueryData(authKeys.me())).toBeUndefined();
    expect(navigateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '/login',
        search: expect.objectContaining({ redirect: expect.any(String) }),
      }),
    );
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
});
