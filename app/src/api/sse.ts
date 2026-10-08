import { ApiError, apiBaseUrl, apiClient, unwrap } from './client';
import type {
  Comment,
  Run,
  RunEvent,
  RunEventPage,
  SuggestionProgress,
  SuggestionTerminal,
} from './types';

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
  fetchEventsPage?: (runId: string, afterSeq: number | undefined) => Promise<RunEventPage>;
  /** Test seam: fetch `GET /runs/{runId}` to detect the polling fallback's terminal state. */
  fetchRun?: (runId: string) => Promise<Run>;
}

function defaultCreateEventSource(url: string): EventSourceLike {
  return new EventSource(url);
}

async function defaultFetchEventsPage(
  runId: string,
  afterSeq: number | undefined,
): Promise<RunEventPage> {
  return unwrap(
    apiClient.GET('/api/v1/runs/{run_id}/events', {
      params: { path: { run_id: runId }, query: afterSeq !== undefined ? { afterSeq } : {} },
    }),
  );
}

async function defaultFetchRun(runId: string): Promise<Run> {
  return unwrap(apiClient.GET('/api/v1/runs/{run_id}', { params: { path: { run_id: runId } } }));
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
          stage: 'done',
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

// ---------------------------------------------------------------------------------------------
// Suggestions (the copilot's revisions, issue #182 phase 4)
// ---------------------------------------------------------------------------------------------

export type SuggestionTerminalName = 'done' | 'failed' | 'cancelled';
const SUGGESTION_TERMINAL_NAMES: SuggestionTerminalName[] = ['done', 'failed', 'cancelled'];

/** What `EventSource` reports besides events; absent on test fakes. `0` = the browser is reconnecting. */
export interface ReadyStateSource extends EventSourceLike {
  readyState?: number;
}

export interface SubscribeSuggestionEventsOptions {
  onProgress: (event: SuggestionProgress) => void;
  /** Called once, with the suggestion in its final state (or its state when the stream ended); no more events follow. */
  onTerminal: (name: SuggestionTerminalName, suggestion: Comment | null) => void;
  onError?: (error: unknown) => void;
  /** Polling cadence once the stream is abandoned. Default 2000ms. */
  pollIntervalMs?: number;
  /** Test seam: construct the transport. Defaults to `new EventSource(url)`. */
  createEventSource?: (url: string) => ReadyStateSource;
  /** Test seam: fetch the suggestion row, for the polling fallback. */
  fetchSuggestion?: (suggestionId: string) => Promise<Comment>;
}

async function defaultFetchSuggestion(suggestionId: string): Promise<Comment> {
  return unwrap(
    apiClient.GET('/api/v1/comments/{comment_id}', {
      params: { path: { comment_id: suggestionId } },
    }),
  );
}

function terminalNameOf(status: Comment['status']): SuggestionTerminalName | null {
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  // `pending`, and already `accepted` / `rejected`, all end the stream with `done`.
  return status === 'running' ? null : 'done';
}

/**
 * Follows one revision: `GET /suggestions/{id}/events/stream` (progress events, then exactly one
 * terminal event). The server persists progress events and numbers them (`id` = `seq`), so a
 * reconnect replays what was missed: the browser's own `EventSource` reconnect sends
 * `Last-Event-ID` by itself, and events already seen are dropped by `seq` here either way. After
 * two connection errors in a row (or a connection the browser gave up on) the stream is abandoned
 * and the suggestion row is polled until it leaves `running`, so a proxy that buffers or kills
 * event streams only costs the live progress line. Returns an unsubscribe function.
 */
export function subscribeSuggestionEvents(
  suggestionId: string,
  options: SubscribeSuggestionEventsOptions,
): () => void {
  const {
    onProgress,
    onTerminal,
    onError,
    pollIntervalMs = 2000,
    createEventSource = (url: string) => new EventSource(url) as ReadyStateSource,
    fetchSuggestion = defaultFetchSuggestion,
  } = options;

  let source: ReadyStateSource | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSeq = -1;
  let consecutiveErrors = 0;
  let stopped = false;

  function cleanup(): void {
    source?.close();
    source = undefined;
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = undefined;
  }

  function finish(name: SuggestionTerminalName, suggestion: Comment | null): void {
    if (stopped) return;
    stopped = true;
    cleanup();
    onTerminal(name, suggestion);
  }

  async function pollOnce(): Promise<void> {
    if (stopped) return;
    try {
      const row = await fetchSuggestion(suggestionId);
      const name = terminalNameOf(row.status);
      if (name) {
        finish(name, row);
        return;
      }
    } catch (cause) {
      onError?.(cause);
      // The suggestion is gone (deleted, or its node was): there is nothing left to wait for.
      if (cause instanceof ApiError && cause.status === 404) {
        finish('cancelled', null);
        return;
      }
    }
    if (!stopped) pollTimer = setTimeout(() => void pollOnce(), pollIntervalMs);
  }

  function abandonStream(): void {
    source?.close();
    source = undefined;
    void pollOnce();
  }

  const es = createEventSource(
    `${apiBaseUrl}/api/v1/suggestions/${encodeURIComponent(suggestionId)}/events/stream`,
  );
  source = es;
  es.addEventListener('progress', (raw) => {
    consecutiveErrors = 0;
    try {
      const event = JSON.parse(raw.data as string) as SuggestionProgress;
      if (event.seq <= lastSeq) return;
      lastSeq = event.seq;
      onProgress(event);
    } catch (cause) {
      onError?.(cause);
    }
  });
  for (const name of SUGGESTION_TERMINAL_NAMES) {
    es.addEventListener(name, (raw) => {
      let suggestion: Comment | null = null;
      try {
        suggestion = (JSON.parse(raw.data as string) as SuggestionTerminal).suggestion ?? null;
      } catch (cause) {
        onError?.(cause);
      }
      finish(name, suggestion);
    });
  }
  es.addEventListener('error', (raw) => {
    onError?.(raw);
    if (stopped) return;
    consecutiveErrors += 1;
    // `readyState` 0: the browser is already reconnecting (and will send `Last-Event-ID`); anything
    // else means it gave up (an HTTP error, a closed connection).
    const reconnecting = es.readyState === 0;
    if (!reconnecting || consecutiveErrors >= ERRORS_BEFORE_FALLBACK) abandonStream();
  });

  return () => {
    stopped = true;
    cleanup();
  };
}
