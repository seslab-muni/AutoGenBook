import { useQuery } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { MOCK_USER, MOCK_USER_PASSWORD } from '@/mocks/fixtures';
import { renderWithQueryClient, waitFor } from '@/test/query-test-utils';

import { auth, useLoginMutation, useLogoutMutation } from './auth';
import { authKeys } from './keys';

describe('auth queries', () => {
  it('auth.me() resolves the seeded mock user (the default "signed in" mock state)', async () => {
    const { result } = renderWithQueryClient(() => useQuery(auth.me()));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(MOCK_USER);
  });

  it('logging in with the right credentials seeds the auth.me() cache with the returned user', async () => {
    const { result, queryClient } = renderWithQueryClient(() => useLoginMutation());

    result.current.mutate({ email: MOCK_USER.email, password: MOCK_USER_PASSWORD });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(MOCK_USER);
    expect(queryClient.getQueryData(authKeys.me())).toEqual(MOCK_USER);
  });

  it('logging in with the wrong credentials fails with a 401', async () => {
    const { result } = renderWithQueryClient(() => useLoginMutation());

    result.current.mutate({ email: MOCK_USER.email, password: 'not-the-password' });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('logging out drops the cached auth.me() data', async () => {
    const { result, queryClient } = renderWithQueryClient(() => useLogoutMutation());
    queryClient.setQueryData(authKeys.me(), MOCK_USER);

    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryData(authKeys.me())).toBeUndefined();
  });
});
