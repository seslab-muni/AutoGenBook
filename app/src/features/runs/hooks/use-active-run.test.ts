import { beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeRunEvents } from '@/api/sse';
import { useCreateRunMutation } from '@/api/queries/runs';
import { renderWithQueryClient, waitFor } from '@/test/query-test-utils';

import { useActiveRun } from './use-active-run';

// See `use-run-stream.test.ts` for why SSE is mocked in every test that renders a hook/component
// which (transitively) subscribes to a run's live stream.
vi.mock('@/api/sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sse')>();
  return { ...actual, subscribeRunEvents: vi.fn() };
});

const mockedSubscribe = vi.mocked(subscribeRunEvents);

const PROJECT_ID = 'book-consensus-quantum-2026';

describe('useActiveRun', () => {
  beforeEach(() => {
    mockedSubscribe.mockReset();
    mockedSubscribe.mockReturnValue(vi.fn());
  });

  it('reports no active run for a project with only historical (terminal) runs', async () => {
    const { result } = renderWithQueryClient(() => useActiveRun(PROJECT_ID));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.activeRun).toBeUndefined();
    expect(result.current.sectionNodeIds.size).toBe(0);
    // No run is active, so `useRunStream` inside `useActiveRun` never had a runId to subscribe to.
    expect(mockedSubscribe).not.toHaveBeenCalled();
  });

  it('picks up a newly queued run as the active one and subscribes to its stream', async () => {
    const { result } = renderWithQueryClient(() => ({
      active: useActiveRun(PROJECT_ID),
      create: useCreateRunMutation(PROJECT_ID),
    }));
    await waitFor(() => expect(result.current.active.isLoading).toBe(false));

    result.current.create.mutate({});
    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));
    const runId = result.current.create.data!.id;

    await waitFor(() => expect(result.current.active.activeRun?.id).toBe(runId));
    expect(mockedSubscribe).toHaveBeenCalledWith(runId, expect.anything());
  });

  it('tracks node ids seen via section events for the active run', async () => {
    const { result } = renderWithQueryClient(() => ({
      active: useActiveRun(PROJECT_ID),
      create: useCreateRunMutation(PROJECT_ID),
    }));
    await waitFor(() => expect(result.current.active.isLoading).toBe(false));

    result.current.create.mutate({});
    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.active.activeRun).toBeDefined());

    const { onEvent } = mockedSubscribe.mock.calls[0]![1];
    onEvent(
      {
        seq: 1,
        ts: '2026-09-07T00:00:00Z',
        level: 'info',
        stage: 'section',
        message: 'x',
        payload: { nodeId: 'n-1' },
      },
      'section',
    );

    await waitFor(() => expect(result.current.active.sectionNodeIds.has('n-1')).toBe(true));
  });
});
