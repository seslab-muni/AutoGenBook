import type { SourceStatus } from '@/api/types';

interface StatusPresentation {
  label: string;
  dotClassName: string;
  textClassName: string;
  hint: string;
}

/** `chunksCount`/`status` are only filled in by a run's `kb_sources.json` (issue #10) — a fresh
 * attach is always `ready`, so most projects show grey dots until the first run completes. */
export const SOURCE_STATUS_PRESENTATION: Record<SourceStatus, StatusPresentation> = {
  ready: {
    label: 'Awaiting first run',
    dotClassName: 'bg-muted-foreground/50',
    textClassName: 'text-muted-foreground',
    hint: 'Not indexed yet — attach, then start a run to index it into the knowledge base.',
  },
  indexed: {
    label: 'Indexed',
    dotClassName: 'bg-success',
    textClassName: 'text-success',
    hint: 'Indexed into the knowledge base by the last run.',
  },
  error: {
    label: 'Not indexed',
    dotClassName: 'bg-destructive',
    textClassName: 'text-destructive',
    hint: 'Eligible but not indexed by the last run — check the run log for details.',
  },
};
