import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runKeys, projectKeys } from '@/api/queries/keys';
import { subscribeRunEvents } from '@/api/sse';
import type { RunEvent } from '@/api/types';
import { db } from '@/mocks/db';
import { renderWithQueryClient, waitFor } from '@/test/query-test-utils';

import { useRunStream } from './use-run-stream';

/**
 * `subscribeRunEvents` is mocked for every test in this file: the project's
 * own convention (see `app/README.md`'s testing section, and the comments in
 * `src/api/{sse,upload}.test.ts`) is that real `EventSource` traffic doesn't
 * survive jsdom's interop with MSW reliably, so lower-level SSE mechanics
 * (reconnect backoff, polling fallback) stay covered by `sse.test.ts`'s
 * injectable fake, and this suite instead controls exactly which events
 * `useRunStream` observes by capturing and manually invoking the callbacks
 * it passes to `subscribeRunEvents`.
 */
vi.mock('@/api/sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sse')>();
  return { ...actual, subscribeRunEvents: vi.fn() };
});

const mockedSubscribe = vi.mocked(subscribeRunEvents);

function seedRun(runId: string, projectId: string, status: 'queued' | 'running' = 'running') {
  db.runs.set(runId, {
    id: runId,
    projectId,
    kind: 'full',
    status,
    options: {},
    baseRunId: null,
    targetNodeId: null,
    exitCode: null,
    error: null,
    totalTokens: null,
    totalCostUsd: null,
    resumable: true,
    queuedAt: '2026-09-07T00:00:00Z',
    startedAt: '2026-09-07T00:00:01Z',
    finishedAt: null,
  });
}

function makeEvent(seq: number, extra: Partial<RunEvent> = {}): RunEvent {
  return { seq, ts: '2026-09-07T00:00:00Z', level: 'info', message: `event ${seq}`, ...extra };
}

describe('useRunStream', () => {
  beforeEach(() => {
    mockedSubscribe.mockReset();
    // Every mount needs a callable "unsubscribe" back, or the auto-unmount at the end of each
    // test (React Testing Library's cleanup) throws trying to call `undefined()`. Tests that
    // care about the specific unsubscribe function override this with their own `mockReturnValue`.
    mockedSubscribe.mockReturnValue(vi.fn());
  });

  it('subscribes once and appends events into the shared live-events cache, deduped by seq', () => {
    seedRun('run-a', 'proj-a');

    const { queryClient } = renderWithQueryClient(() => useRunStream('run-a', 'proj-a'));

    expect(mockedSubscribe).toHaveBeenCalledTimes(1);
    const { onEvent } = mockedSubscribe.mock.calls[0]![1];

    onEvent(makeEvent(1, { stage: 'planning' }), 'stage');
    onEvent(makeEvent(2), 'log');
    onEvent(makeEvent(2), 'log'); // duplicate seq - must not double up

    const cached = queryClient.getQueryData<RunEvent[]>(runKeys.liveEvents('run-a'));
    expect(cached).toHaveLength(2);
    expect(cached?.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('derives currentStage from the most recent event carrying a stage', async () => {
    seedRun('run-b', 'proj-a');

    const { result } = renderWithQueryClient(() => useRunStream('run-b', 'proj-a'));
    const { onEvent } = mockedSubscribe.mock.calls[0]![1];

    onEvent(makeEvent(1, { stage: 'planning' }), 'stage');
    onEvent(makeEvent(2, { stage: 'drafting' }), 'stage');
    onEvent(makeEvent(3), 'log');

    await waitFor(() => expect(result.current.currentStage).toBe('drafting'));
  });

  it('a section event records the node id from its payload and invalidates the project outline', async () => {
    seedRun('run-c', 'proj-c');

    const { result, queryClient } = renderWithQueryClient(() => useRunStream('run-c', 'proj-c'));
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { onEvent } = mockedSubscribe.mock.calls[0]![1];

    onEvent(makeEvent(1, { payload: { nodeId: 'node-42' } }), 'section');

    await waitFor(() => expect(result.current.sectionNodeIds.has('node-42')).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: projectKeys.outline('proj-c') });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: projectKeys.detail('proj-c') });
  });

  it('ref-counts: a second mount for the same run reuses the one subscription, only unsubscribing once every mount is gone', () => {
    seedRun('run-d', 'proj-d');
    const unsubscribe = vi.fn();
    mockedSubscribe.mockReturnValue(unsubscribe);

    const first = renderWithQueryClient(() => useRunStream('run-d', 'proj-d'));
    const second = renderWithQueryClient(() => useRunStream('run-d', 'proj-d'));

    expect(mockedSubscribe).toHaveBeenCalledTimes(1);

    first.unmount();
    expect(unsubscribe).not.toHaveBeenCalled();

    second.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('remounting after a full unmount resumes from the last cached seq', () => {
    seedRun('run-e', 'proj-e');
    mockedSubscribe.mockReturnValue(vi.fn());

    const first = renderWithQueryClient(() => useRunStream('run-e', 'proj-e'));
    const { onEvent } = mockedSubscribe.mock.calls[0]![1];
    onEvent(makeEvent(7), 'log');
    first.unmount();

    renderWithQueryClient(() => useRunStream('run-e', 'proj-e'), {
      queryClient: first.queryClient,
    });

    expect(mockedSubscribe).toHaveBeenCalledTimes(2);
    expect(mockedSubscribe.mock.calls[1]![1].lastEventId).toBe(7);
  });

  it('does not subscribe at all for a run already cached as terminal', () => {
    seedRun('run-f', 'proj-f', 'queued');

    const { queryClient } = renderWithQueryClient(() => useRunStream('run-f', 'proj-f'));
    queryClient.setQueryData(runKeys.detail('run-f'), {
      ...db.runs.get('run-f'),
      status: 'succeeded',
    });

    renderWithQueryClient(() => useRunStream('run-f', 'proj-f'), { queryClient });

    // The first mount (run cached as "queued") did subscribe; a second mount, now that the
    // run is cached as terminal, must not open a new one.
    expect(mockedSubscribe).toHaveBeenCalledTimes(1);
  });

  it('a "done" event invalidates the run/project caches', async () => {
    seedRun('run-g', 'proj-g');

    const { result, queryClient } = renderWithQueryClient(() => useRunStream('run-g', 'proj-g'));
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { onDone } = mockedSubscribe.mock.calls[0]![1];

    db.runs.set('run-g', {
      ...db.runs.get('run-g')!,
      status: 'succeeded',
      totalTokens: 100,
      totalCostUsd: 1.5,
    });
    onDone!(makeEvent(9, { message: 'Run succeeded.' }));

    await waitFor(() => expect(result.current.events.some((e) => e.seq === 9)).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: runKeys.detail('run-g') });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: runKeys.artifacts('run-g') });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: projectKeys.runs('proj-g') });
  });
});
