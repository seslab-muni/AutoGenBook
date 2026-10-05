import { useQuery } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { MOCK_USER, MOCK_USER_PASSWORD } from '@/mocks/fixtures';
import { renderWithQueryClient, waitFor } from '@/test/query-test-utils';

import {
  auth,
  useClearLlmKeyMutation,
  useLoginMutation,
  useLogoutMutation,
  useSetLlmKeyMutation,
} from './auth';
import { authKeys } from './keys';

describe('auth queries', () => {
  it('auth.me() resolves the seeded mock user (the default "signed in" mock state)', async () => {
    const { result } = renderWithQueryClient(() => useQuery(auth.me()));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject(MOCK_USER);
    // Per-user LLM key fields: feature on, optional policy, no key stored.
    expect(result.current.data).toMatchObject({
      llmKeyConfigurable: true,
      llmKeyPolicy: 'optional',
      llmKey: null,
    });
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

  it('setting an LLM key writes the returned user (last four only) into the auth.me() cache', async () => {
    const { result, queryClient } = renderWithQueryClient(() => useSetLlmKeyMutation());

    result.current.mutate('sk-or-v1-abcdef1234');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const cached = queryClient.getQueryData<{ llmKey?: { last4: string } | null }>(authKeys.me());
    expect(cached?.llmKey?.last4).toBe('1234');
    expect(JSON.stringify(cached)).not.toContain('abcdef');
  });

  it('clearing the LLM key refetches auth.me() without it', async () => {
    const { result } = renderWithQueryClient(() => ({
      me: useQuery(auth.me()),
      set: useSetLlmKeyMutation(),
      clear: useClearLlmKeyMutation(),
    }));
    await waitFor(() => expect(result.current.me.isSuccess).toBe(true));

    result.current.set.mutate('sk-or-v1-abcdef1234');
    await waitFor(() => expect(result.current.me.data?.llmKey?.last4).toBe('1234'));

    result.current.clear.mutate();
    await waitFor(() => expect(result.current.me.data?.llmKey ?? null).toBeNull());
  });
});
