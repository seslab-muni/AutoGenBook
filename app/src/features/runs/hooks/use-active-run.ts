import { useQuery } from '@tanstack/react-query';

import { runs } from '@/api/queries/runs';
import type { Run } from '@/api/types';

import { useRunStream } from './use-run-stream';

const ACTIVE_STATUSES = new Set<Run['status']>(['queued', 'running']);
const POLL_MS = 5000;

export interface UseActiveRunResult {
  /** The project's queued/running run, if any. */
  activeRun: Run | undefined;
  /** True while the initial `runs.list` fetch is in flight. */
  isLoading: boolean;
  /** Node/cli keys `activeRun` has drafted a section for so far — for per-node "still generating" spinners. */
  sectionNodeIds: Set<string>;
}

/**
 * Derives the project's active (queued/running) run from `runs.list`,
 * polling every `POLL_MS` as a safety net while one is active (in case the
 * SSE/poll-fallback in `useRunStream` misses the final `done`), and keeps a
 * live SSE subscription open for it app-wide via `useRunStream` — so the
 * outline/header reflect progress even when the Copilot panel isn't open.
 * Mount this once high in the project layout (`AppHeader`'s parent) rather
 * than in every consumer; consumers just read its return value.
 */
export function useActiveRun(projectId: string): UseActiveRunResult {
  const query = useQuery({
    ...runs.list(projectId, { limit: 20 }),
    refetchInterval: (latest) => {
      const items = latest.state.data?.items ?? [];
      return items.some((run) => ACTIVE_STATUSES.has(run.status)) ? POLL_MS : false;
    },
  });

  const activeRun = query.data?.items.find((run) => ACTIVE_STATUSES.has(run.status));
  const { sectionNodeIds } = useRunStream(activeRun?.id, projectId);

  return { activeRun, isLoading: query.isPending, sectionNodeIds };
}
