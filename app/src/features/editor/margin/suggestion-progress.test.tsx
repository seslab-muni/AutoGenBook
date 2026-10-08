import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeSuggestionEvents, type SubscribeSuggestionEventsOptions } from '@/api/sse';
import { projectKeys } from '@/api/queries/keys';
import type { Comment, Page } from '@/api/types';

import { useUnticked } from './hunk-selection';
import { useSuggestionProgress, useSuggestionStreams } from './suggestion-progress';
import { makeComment, makeSuggestion } from './test-helpers';

vi.mock('@/api/sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sse')>();
  return { ...actual, subscribeSuggestionEvents: vi.fn(() => () => {}) };
});

const subscribe = vi.mocked(subscribeSuggestionEvents);
const PROJECT = 'book-reinforcement-learning';
const NODE = 'rl-sec-1-1';

type Thread = { root: Comment; replies: Comment[] };
const thread = (root: Comment, replies: Comment[] = []): Thread => ({ root, replies });

function setup(initial: Thread[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rows = initial.flatMap((t) => [t.root, ...t.replies]);
  queryClient.setQueryData<Page<Comment>>(projectKeys.nodeComments(PROJECT, NODE), {
    items: rows,
    total: initial.length,
    limit: rows.length,
    offset: 0,
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    ({ threads }: { threads: Thread[] }) => useSuggestionStreams(PROJECT, NODE, threads),
    { wrapper, initialProps: { threads: initial } },
  );
  return { ...hook, queryClient };
}

let handlers: Map<string, SubscribeSuggestionEventsOptions>;
let stops: Map<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  handlers = new Map();
  stops = new Map();
  subscribe.mockReset();
  subscribe.mockImplementation((id, options) => {
    handlers.set(id, options);
    const stop = vi.fn();
    stops.set(id, stop);
    return stop;
  });
  useSuggestionProgress.setState({ events: {} });
});

describe('useSuggestionStreams', () => {
  it('follows every running suggestion by id (also after a reload), and nothing else', () => {
    setup([
      thread(makeSuggestion({ id: 'run-1' })),
      thread(makeSuggestion({ id: 'done-1', status: 'pending' })),
      thread(makeComment({ id: 'c-1' })),
      // A suggestion running inside a comment thread counts too.
      thread(makeComment({ id: 'c-2' }), [
        makeSuggestion({ id: 'run-2', parentId: 'c-2', threadId: 'c-2' }),
      ]),
    ]);
    expect([...handlers.keys()].sort()).toEqual(['run-1', 'run-2']);
  });

  it('puts progress events in the store, in order, without duplicates', () => {
    setup([thread(makeSuggestion({ id: 'run-1' }))]);
    const { onProgress } = handlers.get('run-1')!;
    const event = (seq: number) => ({
      seq,
      ts: '',
      stage: 'revise',
      level: 'info',
      message: String(seq),
    });
    act(() => {
      onProgress(event(2));
      onProgress(event(1));
      onProgress(event(2));
    });
    expect(useSuggestionProgress.getState().events['run-1']?.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('on the terminal event writes the finished suggestion into the threads and the badge, and forgets the progress', () => {
    const row = makeSuggestion({ id: 'run-1' });
    const { queryClient } = setup([thread(row)]);
    handlers
      .get('run-1')!
      .onProgress({ seq: 1, ts: '', stage: 'retrieve', level: 'info', message: 'x' });
    act(() =>
      handlers
        .get('run-1')!
        .onTerminal('done', { ...row, status: 'pending', bodyMarkdown: 'Summary' }),
    );
    const cached = queryClient.getQueryData<Page<Comment>>(projectKeys.nodeComments(PROJECT, NODE));
    expect(cached?.items.find((item) => item.id === 'run-1')).toMatchObject({
      status: 'pending',
      bodyMarkdown: 'Summary',
    });
    expect(useSuggestionProgress.getState().events['run-1']).toBeUndefined();
  });

  it('stops following a suggestion once it is no longer running, and on unmount', () => {
    const row = makeSuggestion({ id: 'run-1' });
    const view = setup([thread(row)]);
    expect(subscribe).toHaveBeenCalledTimes(1);
    view.rerender({ threads: [thread({ ...row, status: 'pending' })] });
    expect(stops.get('run-1')).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledTimes(1);

    // A new running suggestion is followed, and unmounting lets go of it.
    view.rerender({ threads: [thread(makeSuggestion({ id: 'run-9' }))] });
    expect(subscribe).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(stops.get('run-9')).toHaveBeenCalled();
  });

  it('does not subscribe twice for the same suggestion across re-renders', () => {
    const row = makeSuggestion({ id: 'run-1' });
    const view = setup([thread(row)]);
    view.rerender({ threads: [thread({ ...row, updatedAt: 'later' })] });
    view.rerender({ threads: [thread({ ...row, bodyMarkdown: 'x' })] });
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('does not count a suggestion the person already cancelled a second time when the stream says cancelled', () => {
    const row = makeSuggestion({ id: 'run-1' });
    const { queryClient } = setup([thread(row)]);
    // The outline row says one pending suggestion; the cancel call has settled it (status cancelled, badge 0).
    queryClient.setQueryData(projectKeys.outlineList(PROJECT, 'flat'), {
      items: [{ id: NODE, pendingSuggestionCount: 2 }],
      total: 1,
      limit: 1,
      offset: 0,
    });
    queryClient.setQueryData<Page<Comment>>(projectKeys.nodeComments(PROJECT, NODE), {
      items: [{ ...row, status: 'cancelled' }],
      total: 1,
      limit: 1,
      offset: 0,
    });
    act(() => handlers.get('run-1')!.onTerminal('cancelled', { ...row, status: 'cancelled' }));
    const flat = queryClient.getQueryData<Page<{ id: string; pendingSuggestionCount: number }>>(
      projectKeys.outlineList(PROJECT, 'flat'),
    );
    // Not decremented again: another suggestion's count is not eaten.
    expect(flat?.items[0]?.pendingSuggestionCount).toBe(2);
  });

  it('forgets the progress and the ticked hunks of a suggestion whose card is gone', () => {
    const row = makeSuggestion({ id: 'gone' });
    const view = setup([thread(row)]);
    useSuggestionProgress.getState().append('gone', {
      seq: 1,
      ts: '',
      stage: 'revise',
      level: 'info',
      message: 'x',
    });
    useUnticked.getState().toggle('gone', 0);
    useUnticked.getState().toggle('kept', 1);
    view.rerender({ threads: [thread(makeSuggestion({ id: 'kept', status: 'pending' }))] });
    expect(useSuggestionProgress.getState().events['gone']).toBeUndefined();
    expect(useUnticked.getState().unticked['gone']).toBeUndefined();
    expect(useUnticked.getState().unticked['kept']).toEqual([1]);
  });
});
