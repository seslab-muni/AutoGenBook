import { useQuery } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { renderWithQueryClient, waitFor } from '@/test/query-test-utils';

import { runKeys } from './keys';
import { runs, useCancelRunMutation, useCreateRunMutation } from './runs';

const PROJECT_ID = 'book-consensus-quantum-2026';
const RUN_ID = 'book-consensus-quantum-2026-run-1';

describe('runs queries', () => {
  it('fetches the seeded successful run and its artifacts', async () => {
    const { result } = renderWithQueryClient(() => ({
      run: useQuery(runs.detail(RUN_ID)),
      artifacts: useQuery(runs.artifacts(RUN_ID)),
    }));

    await waitFor(() =>
      expect(result.current.run.isSuccess && result.current.artifacts.isSuccess).toBe(true),
    );
    expect(result.current.run.data?.status).toBe('succeeded');
    expect(result.current.artifacts.data?.items.some((a) => a.kind === 'markdown')).toBe(true);
  });

  it('creating a run rejects with 409 while one is already active, and invalidates the run list otherwise', async () => {
    const { result } = renderWithQueryClient(() => ({
      list: useQuery(runs.list(PROJECT_ID)),
      create: useCreateRunMutation(PROJECT_ID),
    }));
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));

    result.current.create.mutate(undefined);
    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));

    expect(result.current.create.data?.kind).toBe('full');
    expect(result.current.create.data?.status).toBe('queued');
    const createdRunId = result.current.create.data?.id;
    await waitFor(() =>
      expect(result.current.list.data?.items.some((run) => run.id === createdRunId)).toBe(true),
    );

    // A second run while the first is still queued/running must be rejected.
    result.current.create.mutate(undefined);
    await waitFor(() => expect(result.current.create.isError).toBe(true));
  });

  it('cancelling a run updates its own cache entry', async () => {
    const { result: createResult } = renderWithQueryClient(() => useCreateRunMutation(PROJECT_ID));
    createResult.current.mutate(undefined);
    await waitFor(() => expect(createResult.current.isSuccess).toBe(true));
    const runId = createResult.current.data!.id;

    const { result, queryClient } = renderWithQueryClient(() => useCancelRunMutation());
    result.current.mutate(runId);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryData(runKeys.detail(runId))).toMatchObject({ status: 'cancelled' });
  });
});
