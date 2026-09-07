import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeRunEvents, type EventSourceLike } from './sse';
import type { Page, Run, RunEvent } from './types';

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
  return { seq, ts: '2026-09-07T00:00:00Z', level: 'info', message };
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
      (runId: string, afterSeq: number | undefined) => Promise<Page<RunEvent>>
    >(() => Promise.resolve({ items: [makeEvent(9)], total: 1, limit: 50, offset: 0 }));
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
      (runId: string, afterSeq: number | undefined) => Promise<Page<RunEvent>>
    >(() => Promise.resolve({ items: [], total: 0, limit: 50, offset: 0 }));
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
