import { useEffect, useRef, useState } from 'react';
import { CircleCheck, TriangleAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ReviewSummary } from '@/features/editor/lib/card-payloads';
import { useNow } from '@/features/editor/lib/use-now';
import { formatRelativeTime } from '@/features/runs/lib/run-format';
import { cn } from '@/lib/utils';
import { countOpenIssues, type MarginThread } from './threads';

interface ReviewSummaryStripProps {
  /** `null` for a section reviewed before review rows existed: only its plain notes can be shown. */
  summary: ReviewSummary | null;
  /** Every thread of the section: the counts are of the open review cards. */
  threads: readonly MarginThread[];
  /** The reviewer's score, when the run produced one (never yet, see #81). */
  score: number | null;
  /** Plain notes from a review before the cards existed (`reviewerNotes`), for the "previous run" list. */
  legacyNotes: string | null;
}

type Open = 'edits' | 'queries' | 'notes' | null;

/**
 * The section's review verdict, a compact fixed header above the margin's cards (they scroll, it does
 * not): a pill from the reviewer's `ok_to_keep`, the counts of the open issue cards, and two lists the
 * cards do not carry (suggested edits, searches that would find missing evidence), each opening as a
 * panel over the cards. A section reviewed before review rows existed shows its old notes the same
 * way, as plain text.
 */
export function ReviewSummaryStrip({
  summary,
  threads,
  score,
  legacyNotes,
}: ReviewSummaryStripProps) {
  const now = useNow();
  const [open, setOpen] = useState<Open>(null);
  const root = useRef<HTMLElement>(null);
  const { major, minor } = countOpenIssues(threads);

  // A panel over the cards closes on Escape from anywhere and on a press outside the header.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setOpen(null);
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [open]);
  const reviewed = summary?.reviewedAt ? formatRelativeTime(summary.reviewedAt, now) : null;

  const toggle = (which: Exclude<Open, null>) => setOpen((now) => (now === which ? null : which));
  const lists: { id: Exclude<Open, null>; label: string; count: number }[] = summary
    ? [
        { id: 'edits', label: 'Suggested edits', count: summary.suggestedEdits.length },
        {
          id: 'queries',
          label: 'Searches that would find missing evidence',
          count: summary.retrievalQueries.length,
        },
      ]
    : [{ id: 'notes', label: 'Review notes (previous run)', count: legacyNotes ? 1 : 0 }];

  return (
    <section
      ref={root}
      aria-label="Review summary"
      className="relative flex flex-col gap-1 border-b bg-card px-3 py-2"
    >
      {summary ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge
            variant="outline"
            data-verdict={summary.okToKeep ? 'ok' : 'needs-revision'}
            className={cn(
              'text-foreground',
              summary.okToKeep
                ? 'border-success/50 bg-success/15'
                : 'border-destructive/50 bg-destructive/15',
            )}
          >
            {summary.okToKeep ? (
              <CircleCheck aria-hidden="true" />
            ) : (
              <TriangleAlert aria-hidden="true" />
            )}
            {summary.okToKeep ? 'OK to keep' : 'Needs revision'}
          </Badge>
          {summary.okToKeep && summary.issueCount === 0 ? (
            <span className="text-xs text-foreground">No issues found</span>
          ) : (
            <span className="text-xs text-foreground">
              {major} major · {minor} minor
            </span>
          )}
          {score != null ? (
            <Badge variant="secondary" className="font-mono">
              {score.toFixed(1)} / 10
            </Badge>
          ) : null}
          {reviewed ? (
            <span className="ml-auto text-[11px] text-foreground">Reviewed {reviewed}</span>
          ) : null}
        </div>
      ) : (
        <span className="text-xs text-foreground">
          This section was reviewed before issues became cards.
        </span>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {lists
          .filter((list) => list.count > 0)
          .map((list) => (
            <Button
              key={list.id}
              type="button"
              variant="link"
              size="xs"
              className="h-auto p-0 text-xs text-foreground"
              aria-expanded={open === list.id}
              onClick={() => toggle(list.id)}
            >
              {list.id === 'notes' ? list.label : `${list.label} (${list.count})`}
            </Button>
          ))}
      </div>
      {open ? (
        <div
          // A panel over the cards (the header itself stays one compact row), scrollable and focusable.
          role="region"
          tabIndex={0}
          aria-label={lists.find((list) => list.id === open)?.label}
          className="absolute inset-x-2 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-md border bg-popover p-2 text-xs text-popover-foreground shadow-md"
        >
          {open === 'edits' && summary ? (
            <ul className="list-disc pl-4">
              {summary.suggestedEdits.map((edit, i) => (
                <li key={i} className="break-words">
                  {edit}
                </li>
              ))}
            </ul>
          ) : null}
          {open === 'queries' && summary ? (
            <ul className="flex flex-wrap gap-1">
              {summary.retrievalQueries.map((query, i) => (
                <li
                  key={i}
                  className="rounded-full border bg-muted px-2 py-0.5 text-[11px] break-words"
                >
                  {query}
                </li>
              ))}
            </ul>
          ) : null}
          {open === 'notes' && legacyNotes ? (
            <p className="break-words whitespace-pre-wrap">{legacyNotes}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
