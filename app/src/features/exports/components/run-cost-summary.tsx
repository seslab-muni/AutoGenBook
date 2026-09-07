import type { Run } from '@/api/types';
import { cn } from '@/lib/utils';
import {
  formatCost,
  formatDuration,
  formatElapsed,
  formatTokens,
} from '@/features/runs/lib/run-format';

const TERMINAL_STATUSES = new Set<Run['status']>(['succeeded', 'failed', 'cancelled']);

interface RunCostSummaryProps {
  run: Run;
  className?: string;
}

/**
 * `duration · tokens · cost` for one run — shared by the export dialog header and the run detail
 * route, built entirely from `run-format.ts` helpers so formatting never drifts between the two.
 */
export function RunCostSummary({ run, className }: RunCostSummaryProps) {
  const isTerminal = TERMINAL_STATUSES.has(run.status);
  const duration = isTerminal ? formatDuration(run.startedAt, run.finishedAt) : formatElapsed(run);
  const tokens = formatTokens(run.totalTokens);
  const cost = formatCost(run.totalCostUsd);

  return (
    <dl className={cn('grid grid-cols-3 gap-x-3 gap-y-1 text-xs', className)}>
      <dt className="text-muted-foreground">Duration</dt>
      <dt className="text-muted-foreground">Tokens</dt>
      <dt className="text-muted-foreground">Cost</dt>
      <dd className="font-mono font-medium text-foreground">{duration ?? '—'}</dd>
      <dd className="font-mono font-medium text-foreground">{tokens ?? '—'}</dd>
      <dd className="font-mono font-medium text-foreground">{cost ?? '—'}</dd>
    </dl>
  );
}
