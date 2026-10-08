import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  subscribeRunEvents,
  subscribeSuggestionEvents,
  type EventSourceLike,
  type ReadyStateSource,
} from './sse';
import type { Comment, Run, RunEvent, RunEventPage, SuggestionProgress } from './types';

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  closed = false;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  raiseError(): void {
    for (const listener of this.listeners.get('error') ?? []) {
      listener({} as MessageEvent);
    }
  }
}

function makeEvent(seq: number, message = 'log'): RunEvent {
  return { seq, ts: '2026-09-07T00:00:00Z', level: 'info', stage: 'drafting', message };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('subscribeRunEvents', () => {
  it('delivers events from the SSE stream', () => {
    const onEvent = vi.fn();
    subscribeRunEvents('run-1', { onEvent, createEventSource: (url) => new FakeEventSource(url) });

    const source = FakeEventSource.instances[0];
    expect(source?.url).toContain('/api/v1/runs/run-1/events/stream');
    source?.emit('stage', makeEvent(1, 'planning'));

    expect(onEvent).toHaveBeenCalledWith(makeEvent(1, 'planning'), 'stage');
  });

  it('calls onDone and stops once the "done" event arrives', () => {
    const onDone = vi.fn();
    subscribeRunEvents('run-1', {
      onEvent: vi.fn(),
      onDone,
      createEventSource: (url) => new FakeEventSource(url),
    });

    const source = FakeEventSource.instances[0]!;
    source.emit('done', makeEvent(1, 'Run succeeded.'));

    expect(onDone).toHaveBeenCalledWith(makeEvent(1, 'Run succeeded.'));
    expect(source.closed).toBe(true);
  });

  it('reconnects with backoff after a single error, resuming from the last seq', () => {
    const onEvent = vi.fn();
    subscribeRunEvents('run-1', { onEvent, createEventSource: (url) => new FakeEventSource(url) });

    FakeEventSource.instances[0]!.emit('log', makeEvent(5));
    FakeEventSource.instances[0]!.raiseError();

    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1000);

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]?.url).toContain('lastEventId=5');
  });

  it('falls back to polling after two consecutive errors', async () => {
    const onEvent = vi.fn();
    const fetchEventsPage = vi.fn<
      (runId: string, afterSeq: number | undefined) => Promise<RunEventPage>
    >(() => Promise.resolve({ items: [makeEvent(9)], total: 1, limit: 50, afterSeq: 9 }));
    const fetchRun = vi.fn<(runId: string) => Promise<Run>>(() =>
      Promise.resolve({ status: 'running' } as Run),
    );

    subscribeRunEvents('run-1', {
      onEvent,
      createEventSource: (url) => new FakeEventSource(url),
      fetchEventsPage,
      fetchRun,
    });

    FakeEventSource.instances[0]!.raiseError();
    await vi.advanceTimersByTimeAsync(1000);
    FakeEventSource.instances[1]!.raiseError();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchEventsPage).toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(onEvent).toHaveBeenCalledWith(makeEvent(9), 'log');
  });

  it('stops polling and calls onDone once the polled run reaches a terminal state', async () => {
    const onDone = vi.fn();
    const fetchEventsPage = vi.fn<
      (runId: string, afterSeq: number | undefined) => Promise<RunEventPage>
    >(() => Promise.resolve({ items: [], total: 0, limit: 50, afterSeq: 0 }));
    const fetchRun = vi.fn<(runId: string) => Promise<Run>>(() =>
      Promise.resolve({
        status: 'succeeded',
        finishedAt: '2026-09-07T00:05:00Z',
        error: null,
      } as Run),
    );

    subscribeRunEvents('run-1', {
      onEvent: vi.fn(),
      onDone,
      createEventSource: (url) => new FakeEventSource(url),
      fetchEventsPage,
      fetchRun,
    });

    FakeEventSource.instances[0]!.raiseError();
    await vi.advanceTimersByTimeAsync(1000);
    FakeEventSource.instances[1]!.raiseError();
    await vi.advanceTimersByTimeAsync(0);

    expect(onDone).toHaveBeenCalled();
    expect(onDone.mock.calls[0]?.[0]).toMatchObject({ level: 'info', message: 'Run succeeded' });
  });

  it('the returned unsubscribe function stops the stream', () => {
    const unsubscribe = subscribeRunEvents('run-1', {
      onEvent: vi.fn(),
      createEventSource: (url) => new FakeEventSource(url),
    });
    unsubscribe();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);

    FakeEventSource.instances[0]!.raiseError();
    vi.advanceTimersByTime(5000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

class FakeSuggestionSource extends FakeEventSource implements ReadyStateSource {
  static all: FakeSuggestionSource[] = [];
  /** 0 = the browser is reconnecting by itself, 2 = it gave up. */
  readyState = 0;
  constructor(url: string) {
    super(url);
    FakeSuggestionSource.all.push(this);
  }
}

function progress(seq: number, stage = 'revise'): SuggestionProgress {
  return { seq, ts: '2026-09-07T00:00:00Z', stage, level: 'info', message: stage, payload: {} };
}

function suggestionRow(status: Comment['status']): Comment {
  return { id: 's1', kind: 'suggestion', status } as Comment;
}

describe('subscribeSuggestionEvents', () => {
  beforeEach(() => {
    FakeSuggestionSource.all = [];
  });

  function subscribe(options: Partial<Parameters<typeof subscribeSuggestionEvents>[1]> = {}) {
    const onProgress = vi.fn();
    const onTerminal = vi.fn();
    const stop = subscribeSuggestionEvents('s1', {
      onProgress,
      onTerminal,
      createEventSource: (url) => new FakeSuggestionSource(url),
      ...options,
    });
    return { onProgress, onTerminal, stop, source: FakeSuggestionSource.all[0]! };
  }

  it("opens the suggestion's stream and delivers progress events", () => {
    const { onProgress, source } = subscribe();
    expect(source.url).toContain('/api/v1/suggestions/s1/events/stream');
    source.emit('progress', progress(1, 'retrieve'));
    source.emit('progress', progress(2));
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls[0]?.[0]).toMatchObject({ seq: 1, stage: 'retrieve' });
  });

  it('drops events it has already seen (a reconnect replays from the last id)', () => {
    const { onProgress, source } = subscribe();
    source.emit('progress', progress(1));
    source.emit('progress', progress(2));
    source.emit('progress', progress(2));
    source.emit('progress', progress(1));
    source.emit('progress', progress(3));
    expect(onProgress.mock.calls.map((call) => (call[0] as SuggestionProgress).seq)).toEqual([
      1, 2, 3,
    ]);
  });

  it.each(['done', 'failed', 'cancelled'] as const)(
    'ends on the %s event with the suggestion it carries, and closes the stream',
    (name) => {
      const { onTerminal, source } = subscribe();
      source.emit(name, { status: 'pending', suggestion: suggestionRow('pending') });
      expect(onTerminal).toHaveBeenCalledWith(name, expect.objectContaining({ id: 's1' }));
      expect(source.closed).toBe(true);
      // Nothing after the terminal event is delivered.
      source.emit('progress', progress(9));
      source.emit('done', { status: 'pending' });
      expect(onTerminal).toHaveBeenCalledTimes(1);
    },
  );

  it('lets the browser reconnect after one error, and polls after two in a row', async () => {
    const fetchSuggestion = vi.fn<(id: string) => Promise<Comment>>(() =>
      Promise.resolve(suggestionRow('running')),
    );
    const { source } = subscribe({ fetchSuggestion, pollIntervalMs: 500 });
    source.raiseError();
    // First error: the EventSource is reconnecting by itself (readyState 0): keep it.
    expect(source.closed).toBe(false);
    expect(fetchSuggestion).not.toHaveBeenCalled();
    source.raiseError();
    await vi.advanceTimersByTimeAsync(0);
    expect(source.closed).toBe(true);
    expect(fetchSuggestion).toHaveBeenCalledTimes(1);
  });

  it('a message between two errors resets the count', async () => {
    const fetchSuggestion = vi.fn<(id: string) => Promise<Comment>>(() =>
      Promise.resolve(suggestionRow('running')),
    );
    const { source } = subscribe({ fetchSuggestion });
    source.raiseError();
    source.emit('progress', progress(1));
    source.raiseError();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSuggestion).not.toHaveBeenCalled();
    expect(source.closed).toBe(false);
  });

  it('polls the row at once when the browser gave up (a refused connection), until it leaves running', async () => {
    const statuses: Comment['status'][] = ['running', 'running', 'pending'];
    const fetchSuggestion = vi.fn<(id: string) => Promise<Comment>>(() =>
      Promise.resolve(suggestionRow(statuses.shift() ?? 'pending')),
    );
    const { onTerminal, source } = subscribe({ fetchSuggestion, pollIntervalMs: 500 });
    source.readyState = 2;
    source.raiseError();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSuggestion).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchSuggestion).toHaveBeenCalledTimes(2);
    expect(onTerminal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(onTerminal).toHaveBeenCalledWith('done', expect.objectContaining({ status: 'pending' }));
    // Polling stops with the terminal state.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchSuggestion).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['accepted', 'done'],
    ['rejected', 'done'],
  ] as const)('maps a polled %s suggestion to the %s terminal', async (status, name) => {
    const { onTerminal, source } = subscribe({
      fetchSuggestion: () => Promise.resolve(suggestionRow(status)),
    });
    source.readyState = 2;
    source.raiseError();
    await vi.advanceTimersByTimeAsync(0);
    expect(onTerminal).toHaveBeenCalledWith(name, expect.objectContaining({ status }));
  });

  it('keeps polling through a failed poll', async () => {
    const fetchSuggestion = vi
      .fn<(id: string) => Promise<Comment>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(suggestionRow('pending'));
    const onError = vi.fn();
    const { onTerminal, source } = subscribe({ fetchSuggestion, pollIntervalMs: 100, onError });
    source.readyState = 2;
    source.raiseError();
    await vi.advanceTimersByTimeAsync(0);
    expect(onTerminal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(onTerminal).toHaveBeenCalledWith('done', expect.anything());
  });

  it('unsubscribing closes the stream and stops the polling', async () => {
    const fetchSuggestion = vi.fn<(id: string) => Promise<Comment>>(() =>
      Promise.resolve(suggestionRow('running')),
    );
    const { stop, source } = subscribe({ fetchSuggestion, pollIntervalMs: 100 });
    source.readyState = 2;
    source.raiseError();
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSuggestion).toHaveBeenCalledTimes(1);
    expect(source.closed).toBe(true);
  });
});
