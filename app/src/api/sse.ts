import { apiBaseUrl, apiClient, unwrap } from './client';
import type { Page, Run, RunEvent } from './types';

export type RunEventName = 'log' | 'stage' | 'section' | 'done';

const RUN_EVENT_NAMES: RunEventName[] = ['log', 'stage', 'section', 'done'];
const ERRORS_BEFORE_FALLBACK = 2;
const RECONNECT_BACKOFF_MS = [1000, 3000, 8000];

/** The subset of `EventSource` this module needs — lets tests inject a fake. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}

export interface SubscribeRunEventsOptions {
  /** Resume after this seq instead of from the start of the run. */
  lastEventId?: number;
  onEvent: (event: RunEvent, name: RunEventName) => void;
  /** Called once, when the run reaches a terminal state; no more events follow. */
  onDone?: (event: RunEvent) => void;
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
  /** Polling cadence used once the SSE connection is abandoned. Default 2000ms. */
  pollIntervalMs?: number;
  /** Test seam: construct the transport. Defaults to `new EventSource(url)`. */
  createEventSource?: (url: string) => EventSourceLike;
  /** Test seam: fetch one page of `GET .../events`. */
  fetchEventsPage?: (runId: string, afterSeq: number | undefined) => Promise<Page<RunEvent>>;
  /** Test seam: fetch `GET /runs/{runId}` to detect the polling fallback's terminal state. */
  fetchRun?: (runId: string) => Promise<Run>;
}

function defaultCreateEventSource(url: string): EventSourceLike {
  return new EventSource(url);
}

async function defaultFetchEventsPage(
  runId: string,
  afterSeq: number | undefined,
): Promise<Page<RunEvent>> {
  return unwrap(
    apiClient.GET('/api/v1/runs/{runId}/events', {
      params: { path: { runId }, query: afterSeq !== undefined ? { afterSeq } : {} },
    }),
  );
}

async function defaultFetchRun(runId: string): Promise<Run> {
  return unwrap(apiClient.GET('/api/v1/runs/{runId}', { params: { path: { runId } } }));
}

function isTerminal(status: Run['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/**
 * Subscribes to a run's progress. Prefers the SSE stream
 * (`GET /runs/{runId}/events/stream`), reconnecting with backoff and
 * resuming from the last seen `seq`; after two consecutive connection
 * errors it falls back to polling `GET .../events` (the `RunEvent` schema
 * has no per-event `name`, so polled events are all surfaced as `'log'`)
 * plus `GET /runs/{runId}` to detect completion, since a polled event page
 * has no terminal marker of its own. Returns an unsubscribe function.
 */
export function subscribeRunEvents(runId: string, options: SubscribeRunEventsOptions): () => void {
  const {
    onEvent,
    onDone,
    onError,
    signal,
    pollIntervalMs = 2000,
    createEventSource = defaultCreateEventSource,
    fetchEventsPage = defaultFetchEventsPage,
    fetchRun = defaultFetchRun,
  } = options;

  let lastSeq = options.lastEventId;
  let source: EventSourceLike | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let consecutiveErrors = 0;
  let stopped = false;

  function cleanup(): void {
    source?.close();
    source = undefined;
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    if (pollTimer !== undefined) clearTimeout(pollTimer);
  }

  function finish(event: RunEvent): void {
    stopped = true;
    cleanup();
    onDone?.(event);
  }

  function buildStreamUrl(): string {
    const url = new URL(`${apiBaseUrl}/api/v1/runs/${runId}/events/stream`, window.location.origin);
    if (lastSeq !== undefined) {
      url.searchParams.set('lastEventId', String(lastSeq));
    }
    return url.toString();
  }

  function onMessage(name: RunEventName) {
    return (raw: MessageEvent): void => {
      consecutiveErrors = 0;
      let event: RunEvent;
      try {
        event = JSON.parse(raw.data as string) as RunEvent;
      } catch (cause) {
        onError?.(cause);
        return;
      }
      lastSeq = event.seq;
      if (name === 'done') {
        finish(event);
        return;
      }
      onEvent(event, name);
    };
  }

  function connectSse(): void {
    if (stopped) return;
    const es = createEventSource(buildStreamUrl());
    source = es;
    for (const name of RUN_EVENT_NAMES) {
      es.addEventListener(name, onMessage(name));
    }
    es.addEventListener('error', (raw) => {
      onError?.(raw);
      es.close();
      if (source === es) source = undefined;
      if (stopped) return;
      consecutiveErrors += 1;
      if (consecutiveErrors >= ERRORS_BEFORE_FALLBACK) {
        void pollOnce();
        return;
      }
      const delay =
        RECONNECT_BACKOFF_MS[Math.min(consecutiveErrors - 1, RECONNECT_BACKOFF_MS.length - 1)];
      reconnectTimer = setTimeout(connectSse, delay);
    });
  }

  async function pollOnce(): Promise<void> {
    if (stopped) return;
    try {
      const [page, run] = await Promise.all([fetchEventsPage(runId, lastSeq), fetchRun(runId)]);
      for (const event of page.items) {
        lastSeq = event.seq;
        onEvent(event, 'log');
      }
      if (isTerminal(run.status)) {
        finish({
          seq: lastSeq ?? 0,
          ts: run.finishedAt ?? new Date().toISOString(),
          level: run.status === 'failed' ? 'error' : 'info',
          message: run.error ?? `Run ${run.status}`,
        });
        return;
      }
    } catch (cause) {
      onError?.(cause);
    }
    if (!stopped) {
      pollTimer = setTimeout(() => void pollOnce(), pollIntervalMs);
    }
  }

  connectSse();

  signal?.addEventListener('abort', () => {
    stopped = true;
    cleanup();
  });

  return () => {
    stopped = true;
    cleanup();
  };
}
