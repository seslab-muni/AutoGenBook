import { useCallback, useId } from 'react';
import { CircleCheck, TriangleAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { ReviewSummary } from '@/features/editor/lib/card-payloads';
import { useNow } from '@/features/editor/lib/use-now';
import { formatRelativeTime } from '@/features/runs/lib/run-format';
import { cn } from '@/lib/utils';
import { countOpenIssues, type MarginThread } from './threads';

/** The strip's key in the margin's layout and height measuring (it is laid out like a pinned card). */
export const STRIP_ID = 'review-summary';

interface ReviewSummaryStripProps {
  summary: ReviewSummary;
  /** Every thread of the section: the counts are of the open review cards. */
  threads: readonly MarginThread[];
  /** The reviewer's score, when the run produced one (never yet, see #81). */
  score: number | null;
  /** Hands the strip's element to the margin, which observes its height. */
  register: (id: string, element: HTMLElement | null) => void;
  /** Offset in the card lane; `undefined` before the first layout. */
  top: number | undefined;
}

function Disclosure({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  const id = useId();
  if (count === 0) return null;
  return (
    <details className="group border-t pt-1.5">
      <summary className="cursor-pointer rounded text-xs font-medium text-foreground select-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
        {label} ({count})
      </summary>
      <div id={id} className="mt-1.5">
        {children}
      </div>
    </details>
  );
}

/**
 * The section's review verdict at the top of the margin (issue #164 built here, once): a pill from
 * the reviewer's `ok_to_keep`, the counts of the open issue cards, and two collapsed lists the
 * cards do not carry (suggested edits, searches that would find missing evidence).
 */
export function ReviewSummaryStrip({
  summary,
  threads,
  score,
  register,
  top,
}: ReviewSummaryStripProps) {
  const ref = useCallback((element: HTMLElement | null) => register(STRIP_ID, element), [register]);
  const now = useNow();
  const { major, minor } = countOpenIssues(threads);
  const reviewed = summary.reviewedAt ? formatRelativeTime(summary.reviewedAt, now) : null;
  const needsRevision = !summary.okToKeep;
  const Icon = needsRevision ? TriangleAlert : CircleCheck;
  const noIssues = summary.okToKeep && summary.issueCount === 0;

  return (
    <section
      ref={ref}
      aria-label="Review summary"
      data-thread-id={STRIP_ID}
      className={cn(
        '@container absolute inset-x-3 flex flex-col gap-1.5 rounded-lg border bg-card p-3 text-card-foreground shadow-xs',
        top === undefined && 'invisible',
      )}
      style={{ top: top ?? 0 }}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge
          variant="outline"
          data-verdict={needsRevision ? 'needs-revision' : 'ok'}
          className={cn(
            'text-foreground',
            needsRevision
              ? 'border-destructive/50 bg-destructive/15'
              : 'border-success/50 bg-success/15',
          )}
        >
          <Icon aria-hidden="true" />
          {needsRevision ? 'Needs revision' : 'OK to keep'}
        </Badge>
        {noIssues ? (
          <span className="text-xs text-muted-foreground">No issues found</span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {major} major · {minor} minor
          </span>
        )}
        {score != null ? (
          <Badge variant="secondary" className="font-mono">
            {score.toFixed(1)} / 10
          </Badge>
        ) : null}
        {reviewed ? (
          <span className="ml-auto text-[11px] text-muted-foreground">Reviewed {reviewed}</span>
        ) : null}
      </div>
      <Disclosure label="Suggested edits" count={summary.suggestedEdits.length}>
        <ul className="max-h-40 list-disc overflow-y-auto pl-4 text-xs">
          {summary.suggestedEdits.map((edit, i) => (
            <li key={i} className="break-words">
              {edit}
            </li>
          ))}
        </ul>
      </Disclosure>
      <Disclosure
        label="Searches that would find missing evidence"
        count={summary.retrievalQueries.length}
      >
        <ul className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
          {summary.retrievalQueries.map((query, i) => (
            <li
              key={i}
              className="rounded-full border bg-muted px-2 py-0.5 text-[11px] break-words"
            >
              {query}
            </li>
          ))}
        </ul>
      </Disclosure>
    </section>
  );
}
