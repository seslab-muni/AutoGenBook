import { useEffect } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { subscribeRunEvents } from '@/api/sse';
import { projectKeys, runKeys } from '@/api/queries/keys';
import { runs } from '@/api/queries/runs';
import type { Run, RunEvent } from '@/api/types';

/**
 * One real subscription per `runId`, shared by every `useRunStream` caller
 * (Copilot panel, run detail page, `useActiveRun`'s app-wide safety net) —
 * ref-counted so mounting the same run in multiple places never opens more
 * than one SSE connection, and the underlying connection survives as long
 * as at least one consumer is mounted.
 */
interface StreamRegistryEntry {
  refCount: number;
  unsubscribe: () => void;
}

const registry = new Map<string, StreamRegistryEntry>();

function appendLiveEvent(queryClient: QueryClient, runId: string, event: RunEvent): void {
  queryClient.setQueryData<RunEvent[]>(runKeys.liveEvents(runId), (prev = []) => {
    if (prev.some((existing) => existing.seq === event.seq)) return prev;
    return [...prev, event].sort((a, b) => a.seq - b.seq);
  });
}

function rememberSectionNode(queryClient: QueryClient, runId: string, event: RunEvent): void {
  // The worker (api/infrastructure/cli/subprocess_runner.py) emits `"section"`
  // events with a `nodeKey` payload field (matching `OutlineNode.cliKey`) -
  // `nodeId`/`cliKey` are never actually sent by the real API, so reading
  // only those left `sectionNodeIds` permanently empty and `outline-pane.tsx`
  // marked every leaf as still generating. Keep reading `nodeId`/`cliKey` too
  // since it costs nothing, in case either is ever added later.
  const payload = event.payload as
    | { nodeKey?: unknown; nodeId?: unknown; cliKey?: unknown }
    | null
    | undefined;
  const nodeKey = typeof payload?.nodeKey === 'string' ? payload.nodeKey : undefined;
  const nodeId = typeof payload?.nodeId === 'string' ? payload.nodeId : undefined;
  const cliKey = typeof payload?.cliKey === 'string' ? payload.cliKey : undefined;
  if (!nodeKey && !nodeId && !cliKey) return;
  queryClient.setQueryData<string[]>(runKeys.sectionNodeIds(runId), (prev = []) => {
    const next = new Set(prev);
    if (nodeKey) next.add(nodeKey);
    if (nodeId) next.add(nodeId);
    if (cliKey) next.add(cliKey);
    return [...next];
  });
}

function outcomeToast(run: Run): void {
  const tokens = run.totalTokens != null ? `${run.totalTokens.toLocaleString()} tokens` : null;
  const cost = run.totalCostUsd != null ? `$${run.totalCostUsd.toFixed(2)}` : null;
  const stats = [tokens, cost].filter(Boolean).join(' · ');
  const description = stats.length > 0 ? stats : undefined;

  if (run.status === 'succeeded') {
    toast.success('Run succeeded', description ? { description } : undefined);
  } else if (run.status === 'failed') {
    toast.error(run.error ?? 'Run failed', description ? { description } : undefined);
  } else if (run.status === 'cancelled') {
    toast.info('Run cancelled', description ? { description } : undefined);
  }
}

function invalidateForDone(
  queryClient: QueryClient,
  runId: string,
  projectId: string | undefined,
): void {
  void queryClient.invalidateQueries({ queryKey: runKeys.detail(runId) });
  void queryClient.invalidateQueries({ queryKey: runKeys.artifacts(runId) });
  if (projectId) {
    void queryClient.invalidateQueries({ queryKey: projectKeys.runs(projectId) });
    void queryClient.invalidateQueries({ queryKey: projectKeys.outline(projectId) });
    void queryClient.invalidateQueries({ queryKey: projectKeys.sources(projectId) });
    void queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
  }
}

function acquire(
  runId: string,
  queryClient: QueryClient,
  projectId: string | undefined,
): () => void {
  const existing = registry.get(runId);
  if (existing) {
    existing.refCount += 1;
    return () => release(runId);
  }

  const cached = queryClient.getQueryData<RunEvent[]>(runKeys.liveEvents(runId));
  const lastEventId = cached && cached.length > 0 ? cached[cached.length - 1]?.seq : undefined;

  const unsubscribe = subscribeRunEvents(runId, {
    ...(lastEventId !== undefined ? { lastEventId } : {}),
    onEvent: (event: RunEvent) => {
      appendLiveEvent(queryClient, runId, event);
      // Checked on the event's own `stage`, not the transport-level `name`
      // SSE hands back (`name` is always `'log'` on the polling fallback -
      // see `sse.ts`'s `pollOnce` - even though the underlying `RunEvent`
      // still carries `stage: 'section'`), so a section landing while the
      // stream has fallen back to polling still refreshes the artifacts
      // list live instead of only once the run finishes (issue #129).
      if (event.stage === 'section') {
        rememberSectionNode(queryClient, runId, event);
        void queryClient.invalidateQueries({ queryKey: runKeys.artifacts(runId) });
        if (projectId) {
          void queryClient.invalidateQueries({ queryKey: projectKeys.outline(projectId) });
          void queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
        }
      }
    },
    onDone: (event: RunEvent) => {
      appendLiveEvent(queryClient, runId, event);
      invalidateForDone(queryClient, runId, projectId);
      void queryClient
        .fetchQuery(runs.detail(runId))
        .then(outcomeToast)
        .catch(() => undefined);
    },
  });

  registry.set(runId, { refCount: 1, unsubscribe });
  return () => release(runId);
}

function release(runId: string): void {
  const entry = registry.get(runId);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    entry.unsubscribe();
    registry.delete(runId);
  }
}

const TERMINAL_STATUSES = new Set<Run['status']>(['succeeded', 'failed', 'cancelled']);

export interface UseRunStreamResult {
  /** Every event seen over this run's stream so far, deduped by `seq` and sorted ascending. */
  events: RunEvent[];
  /** The most recent `stage` value carried by any event (a `section`/`log` event may also carry one). */
  currentStage: string | null;
  /** Node/cli keys a `section` event has arrived for during this run — empty until the first one lands. */
  sectionNodeIds: Set<string>;
}

const EMPTY_EVENTS: RunEvent[] = [];
const EMPTY_SECTION_IDS: string[] = [];

/**
 * Subscribes to `runId`'s live progress (SSE, falling back to polling — see
 * `subscribeRunEvents`) and mirrors it into shared query-cache state so every
 * caller observing the same run (the Copilot panel, the run detail page,
 * `useActiveRun`'s header/outline wiring) sees the same deduped event log
 * without opening more than one connection. No-ops (returns empty state)
 * when `runId` is undefined or already cached as terminal.
 */
export function useRunStream(
  runId: string | undefined,
  projectId: string | undefined,
): UseRunStreamResult {
  const queryClient = useQueryClient();

  const eventsQuery = useQuery<RunEvent[]>({
    queryKey: runId ? runKeys.liveEvents(runId) : ['runs', 'liveEvents', 'none'],
    queryFn: () => Promise.resolve(EMPTY_EVENTS),
    enabled: false,
    initialData: EMPTY_EVENTS,
    staleTime: Infinity,
  });

  const sectionNodesQuery = useQuery<string[]>({
    queryKey: runId ? runKeys.sectionNodeIds(runId) : ['runs', 'sectionNodeIds', 'none'],
    queryFn: () => Promise.resolve(EMPTY_SECTION_IDS),
    enabled: false,
    initialData: EMPTY_SECTION_IDS,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!runId) return;
    // Only skips a run whose terminal status is *already cached* - a runId a caller passes
    // before that run's detail has ever been fetched (e.g. a Copilot panel whose
    // `effectiveRunId` briefly falls back to the project's last, long-finished run before a
    // new one is tracked) still opens a subscription, immediately closed once the caller's
    // runId moves on. Harmless (the connection is torn down on the very next render), just
    // not worth the extra fetch it'd take to avoid it.
    const cachedRun = queryClient.getQueryData<Run>(runKeys.detail(runId));
    if (cachedRun && TERMINAL_STATUSES.has(cachedRun.status)) return;
    return acquire(runId, queryClient, projectId);
  }, [runId, projectId, queryClient]);

  const events = eventsQuery.data ?? EMPTY_EVENTS;
  const currentStage = [...events].reverse().find((event) => event.stage)?.stage ?? null;

  return {
    events,
    currentStage,
    sectionNodeIds: new Set(sectionNodesQuery.data ?? EMPTY_SECTION_IDS),
  };
}
