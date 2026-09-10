import type { Run, RunKind, RunStatus } from '@/api/types';

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const RUN_STATUS_CLASSES: Record<RunStatus, string> = {
  queued: 'bg-muted text-muted-foreground',
  running: 'bg-warning/15 text-warning',
  succeeded: 'bg-success/15 text-success',
  failed: 'bg-destructive/15 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
};

/** Dot + text pairs for inline "● Succeeded · 2 h ago" status lines (project cards). */
export const RUN_STATUS_DOT_CLASSES: Record<RunStatus, string> = {
  queued: 'bg-muted-foreground/50',
  running: 'bg-info',
  succeeded: 'bg-success',
  failed: 'bg-destructive',
  cancelled: 'bg-muted-foreground/50',
};

export const RUN_STATUS_TEXT_CLASSES: Record<RunStatus, string> = {
  queued: 'text-muted-foreground',
  running: 'text-info',
  succeeded: 'text-success',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
};

export const RUN_KIND_LABELS: Record<RunKind, string> = {
  full: 'Full run',
  regenerate_section: 'Regenerate section',
  export: 'Export',
};

/** Pipeline stage → accent color, loosely mapping the mock's Planner/Retriever/Writer agent palette onto CLI stage names. */
const STAGE_COLORS: Record<string, string> = {
  planning: 'text-indigo-600 dark:text-indigo-400',
  drafting: 'text-emerald-600 dark:text-emerald-400',
  retrieval: 'text-sky-600 dark:text-sky-400',
  assembly: 'text-amber-600 dark:text-amber-400',
  export: 'text-amber-600 dark:text-amber-400',
  done: 'text-muted-foreground',
};

export function stageColorClass(stage: string | null | undefined): string {
  if (!stage) return 'text-muted-foreground';
  return STAGE_COLORS[stage] ?? 'text-indigo-600 dark:text-indigo-400';
}

const LEVEL_CLASSES: Record<string, string> = {
  error: 'text-destructive',
  warn: 'text-warning',
  info: 'text-muted-foreground',
  debug: 'text-muted-foreground/70',
};

export function levelColorClass(level: string): string {
  return LEVEL_CLASSES[level] ?? 'text-muted-foreground';
}

/** `mm:ss` (or `h:mm:ss` past an hour) between two ISO timestamps; `null` if either is missing. */
export function formatDuration(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Live elapsed time from `startedAt`/`queuedAt` to now, for a still-running run's footer. */
export function formatElapsed(run: Run, now: Date = new Date()): string | null {
  const start = run.startedAt ?? run.queuedAt;
  return formatDuration(start, now.toISOString());
}

/** Coarse "just now" / "5 min ago" / "2 h ago" / "3 d ago" / "Aug 25" for a past ISO timestamp;
 * `null` if it does not parse. Beyond a month the short date is more useful than "6 w ago". */
export function formatRelativeTime(iso: string, now: Date = new Date()): string | null {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatTokens(totalTokens: number | null): string | null {
  return totalTokens != null ? `${totalTokens.toLocaleString()} tokens` : null;
}

export function formatCost(totalCostUsd: number | null): string | null {
  return totalCostUsd != null ? `$${totalCostUsd.toFixed(2)}` : null;
}
