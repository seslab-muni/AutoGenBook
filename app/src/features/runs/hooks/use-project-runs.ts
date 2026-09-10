import { useQuery } from '@tanstack/react-query';

import { runs } from '@/api/queries/runs';
import type { Run } from '@/api/types';

import { useRunStream } from './use-run-stream';

const ACTIVE_STATUSES: Run['status'][] = ['queued', 'running'];
const POLL_MS = 5000;
// A queued-only lane (nothing running yet) polls faster than `POLL_MS` — unlike a running run,
// which has `useRunStream`'s SSE subscription open the moment it exists, a run still waiting to
// be claimed has no live connection of its own yet, so this poll is the only way the header/
// outline notice the claim promptly once the worker actually starts it.
const QUEUED_ONLY_POLL_MS = 1000;

export interface UseProjectRunsResult {
  /** The project's single running run, if any — only one run per project is ever `running` at a time (issue #134). */
  runningRun: Run | undefined;
  /** The project's queued runs, oldest first — matches each run's `queuePosition`. */
  queuedRuns: Run[];
  /** `runningRun` (if any) followed by `queuedRuns` — every run currently occupying the project's lane. */
  activeRuns: Run[];
  /** True while the initial `runs.list` fetch is in flight. */
  isLoading: boolean;
  /** Node/cli keys `runningRun` has drafted a section for so far — for per-node "still generating" spinners. */
  sectionNodeIds: Set<string>;
}

/**
 * Derives the project's active (queued/running) runs from `runs.list`
 * (filtered server-side via `?status=`, issue #134), polling every
 * `POLL_MS` as a safety net while any are active (in case the SSE/poll-
 * fallback in `useRunStream` misses the final `done`), and keeps a live SSE
 * subscription open for `runningRun` app-wide via `useRunStream` — so the
 * outline/header reflect progress even when the Copilot panel isn't open.
 * Mount this once high in the project layout (`AppHeader`'s parent) rather
 * than in every consumer; consumers just read its return value.
 */
export function useProjectRuns(projectId: string): UseProjectRunsResult {
  const query = useQuery({
    ...runs.list(projectId, { limit: 20, status: ACTIVE_STATUSES }),
    refetchInterval: (latest) => {
      const active = latest.state.data?.items ?? [];
      if (active.length === 0) return false;
      return active.some((run) => run.status === 'running') ? POLL_MS : QUEUED_ONLY_POLL_MS;
    },
  });

  const items = query.data?.items ?? [];
  const runningRun = items.find((run) => run.status === 'running');
  // `runs.list` sorts newest-queued-first (`RunRepository.list`'s `queued_at.desc()`); reversed
  // here so `queuedRuns[0]` is the run actually next in line, matching its `queuePosition`.
  const queuedRuns = items
    .filter((run) => run.status === 'queued')
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  const activeRuns = runningRun ? [runningRun, ...queuedRuns] : queuedRuns;

  const { sectionNodeIds } = useRunStream(runningRun?.id, projectId);

  return { runningRun, queuedRuns, activeRuns, isLoading: query.isPending, sectionNodeIds };
}
