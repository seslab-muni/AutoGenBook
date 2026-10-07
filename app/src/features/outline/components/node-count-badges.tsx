import type { OutlineNode } from '@/api/types';
import { cn } from '@/lib/utils';

interface CountBadgeProps {
  count: number;
  label: string;
  className: string;
}

function CountBadge({ count, label, className }: CountBadgeProps) {
  // `role="img"` makes the pill one labelled thing for assistive tech; the digit is presentational
  // (the title is the tooltip). Kept to the digit alone so the section title keeps the row's width.
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-4 min-w-4 shrink-0 items-center justify-center px-1 text-[10px] leading-none font-semibold tabular-nums',
        className,
      )}
    >
      <span aria-hidden="true">{count}</span>
    </span>
  );
}

/**
 * The outline row's margin badges (issue #182): open comment threads (yellow, round) and AI
 * suggestions waiting for a decision (amber, square), from the node's `openCommentCount` /
 * `pendingSuggestionCount`. Count-only pills: the two kinds differ by shape as well as colour, and
 * the kind is in the accessible name and tooltip. Renders nothing for a node with neither.
 */
export function NodeCountBadges({
  node,
}: {
  node: Pick<OutlineNode, 'openCommentCount' | 'pendingSuggestionCount'>;
}) {
  const comments = node.openCommentCount ?? 0;
  const suggestions = node.pendingSuggestionCount ?? 0;
  if (comments === 0 && suggestions === 0) return null;
  return (
    <>
      {comments > 0 ? (
        <CountBadge
          count={comments}
          label={`${comments} open ${comments === 1 ? 'comment' : 'comments'}`}
          className="rounded-full bg-yellow-400/30 text-yellow-900 dark:bg-yellow-400/25 dark:text-yellow-200"
        />
      ) : null}
      {suggestions > 0 ? (
        <CountBadge
          count={suggestions}
          label={`${suggestions} pending ${suggestions === 1 ? 'suggestion' : 'suggestions'}`}
          className="rounded-[3px] bg-amber-500/30 text-amber-900 dark:bg-amber-500/25 dark:text-amber-200"
        />
      ) : null}
    </>
  );
}
