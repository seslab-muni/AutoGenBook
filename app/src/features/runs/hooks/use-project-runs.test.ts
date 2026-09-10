import { beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeRunEvents } from '@/api/sse';
import { useCreateRunMutation } from '@/api/queries/runs';
import { renderWithQueryClient, waitFor } from '@/test/query-test-utils';

import { useProjectRuns } from './use-project-runs';

// See `use-run-stream.test.ts` for why SSE is mocked in every test that renders a hook/component
// which (transitively) subscribes to a run's live stream.
vi.mock('@/api/sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sse')>();
  return { ...actual, subscribeRunEvents: vi.fn() };
});

const mockedSubscribe = vi.mocked(subscribeRunEvents);

const PROJECT_ID = 'book-consensus-quantum-2026';

describe('useProjectRuns', () => {
  beforeEach(() => {
    mockedSubscribe.mockReset();
    mockedSubscribe.mockReturnValue(vi.fn());
  });

  it('reports no running/queued runs for a project with only historical (terminal) runs', async () => {
    const { result } = renderWithQueryClient(() => useProjectRuns(PROJECT_ID));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.runningRun).toBeUndefined();
    expect(result.current.queuedRuns).toEqual([]);
    expect(result.current.activeRuns).toEqual([]);
    expect(result.current.sectionNodeIds.size).toBe(0);
    // No run is running, so `useRunStream` inside `useProjectRuns` never had a runId to subscribe to.
    expect(mockedSubscribe).not.toHaveBeenCalled();
  });

  it('picks up a newly created run as queued immediately, ahead of the running transition', async () => {
    const { result } = renderWithQueryClient(() => ({
      projectRuns: useProjectRuns(PROJECT_ID),
      create: useCreateRunMutation(PROJECT_ID),
    }));
    await waitFor(() => expect(result.current.projectRuns.isLoading).toBe(false));

    result.current.create.mutate({});
    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));
    const runId = result.current.create.data!.id;

    await waitFor(() => expect(result.current.projectRuns.queuedRuns[0]?.id).toBe(runId));
    expect(result.current.projectRuns.runningRun).toBeUndefined();
    // Nothing is running yet, so no SSE subscription has opened for it.
    expect(mockedSubscribe).not.toHaveBeenCalled();
  });

  it('subscribes to the run once the mock worker claims it off the queue', async () => {
    const { result } = renderWithQueryClient(() => ({
      projectRuns: useProjectRuns(PROJECT_ID),
      create: useCreateRunMutation(PROJECT_ID),
    }));
    await waitFor(() => expect(result.current.projectRuns.isLoading).toBe(false));

    result.current.create.mutate({});
    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));
    const runId = result.current.create.data!.id;

    // `driveFakeRun` claims the run off the queue ~300ms after creation (real timers), and this
    // hook's own queued-only poll (`QUEUED_ONLY_POLL_MS`) only notices on its next tick - the
    // generous timeout here is CI-jitter headroom on real timers, not the nominal time this
    // takes (see `export-dialog.test.tsx`'s note on the same class of real-timer test).
    await waitFor(() => expect(result.current.projectRuns.runningRun?.id).toBe(runId), {
      timeout: 10000,
    });
    expect(mockedSubscribe).toHaveBeenCalledWith(runId, expect.anything());
  }, 15000);

  it('tracks node ids seen via section events for the running run', async () => {
    const { result } = renderWithQueryClient(() => ({
      projectRuns: useProjectRuns(PROJECT_ID),
      create: useCreateRunMutation(PROJECT_ID),
    }));
    await waitFor(() => expect(result.current.projectRuns.isLoading).toBe(false));

    result.current.create.mutate({});
    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));

    await waitFor(() => expect(result.current.projectRuns.runningRun).toBeDefined(), {
      timeout: 10000,
    });

    const { onEvent } = mockedSubscribe.mock.calls[0]![1];
    onEvent(
      {
        seq: 1,
        ts: '2026-09-07T00:00:00Z',
        level: 'info',
        stage: 'section',
        message: 'x',
        payload: { nodeKey: 'n-1' },
      },
      'section',
    );

    await waitFor(() => expect(result.current.projectRuns.sectionNodeIds.has('n-1')).toBe(true));
  }, 15000);
});
