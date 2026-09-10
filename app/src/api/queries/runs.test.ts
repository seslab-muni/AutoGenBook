import { useQuery } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { db } from '@/mocks/db';
import { renderWithQueryClient, waitFor } from '@/test/query-test-utils';
import { DEFAULT_RUN_OPTIONS } from '@/test/run-options-fixture';

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

  it('a second full run queues behind an already-queued one instead of 409ing, and the run list picks it up (issue #134)', async () => {
    const { result } = renderWithQueryClient(() => ({
      list: useQuery(runs.list(PROJECT_ID)),
      create: useCreateRunMutation(PROJECT_ID),
    }));
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));

    const first = await result.current.create.mutateAsync({});
    expect(first.kind).toBe('full');
    expect(first.status).toBe('queued');
    await waitFor(() =>
      expect(result.current.list.data?.items.some((run) => run.id === first.id)).toBe(true),
    );

    // A second run while the first is still queued/running now queues behind it (position 2)
    // rather than being rejected — only `MAX_QUEUED_RUNS_PER_PROJECT` queued runs are refused.
    const second = await result.current.create.mutateAsync({});
    expect(second.status).toBe('queued');
    expect(second.id).not.toBe(first.id);
    await waitFor(() =>
      expect(result.current.list.data?.items.some((run) => run.id === second.id)).toBe(true),
    );
  });

  it("rejects a full run once the project's run queue is full (issue #134)", async () => {
    // Occupies the running slot for the whole test so every run created here stays `queued`
    // deterministically, rather than racing the mock's own ~300ms claim timer.
    db.runs.set('run-already-running', {
      id: 'run-already-running',
      projectId: PROJECT_ID,
      kind: 'full',
      status: 'running',
      options: DEFAULT_RUN_OPTIONS,
      baseRunId: null,
      targetNodeId: null,
      exitCode: null,
      error: null,
      totalTokens: null,
      totalCostUsd: null,
      resumable: true,
      retryable: false,
      queuedAt: '2026-09-06T00:00:00Z',
      startedAt: '2026-09-06T00:00:01Z',
      finishedAt: null,
    });

    const { result } = renderWithQueryClient(() => useCreateRunMutation(PROJECT_ID));

    // `MAX_QUEUED_RUNS_PER_PROJECT` (5, `mocks/handlers.ts`) queued runs are all admitted.
    for (let i = 0; i < 5; i += 1) {
      await result.current.mutateAsync({});
    }

    await expect(result.current.mutateAsync({})).rejects.toThrow();
  });

  it('cancelling a run updates its own cache entry', async () => {
    const { result: createResult } = renderWithQueryClient(() => useCreateRunMutation(PROJECT_ID));
    createResult.current.mutate({});
    await waitFor(() => expect(createResult.current.isSuccess).toBe(true));
    const runId = createResult.current.data!.id;

    const { result, queryClient } = renderWithQueryClient(() => useCancelRunMutation());
    result.current.mutate(runId);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryData(runKeys.detail(runId))).toMatchObject({ status: 'cancelled' });
  });
});
