import { MessageSquare, Sparkles } from 'lucide-react';

import type { OutlineNode } from '@/api/types';
import { cn } from '@/lib/utils';

interface CountBadgeProps {
  count: number;
  icon: React.ReactNode;
  label: string;
  className: string;
}

function CountBadge({ count, icon, label, className }: CountBadgeProps) {
  // `role="img"` makes the pill one labelled thing for assistive tech (its glyph and digit are
  // presentational); the icon, not just the colour, tells the two kinds apart.
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-4 shrink-0 items-center gap-0.5 rounded-full px-1.5 text-[10px] leading-none font-semibold tabular-nums',
        className,
      )}
    >
      {icon}
      {count}
    </span>
  );
}

/**
 * The outline row's margin badges (issue #182): open comment threads (yellow) and AI suggestions
 * waiting for a decision (amber), from the node's `openCommentCount` / `pendingSuggestionCount`.
 * Renders nothing for a node with neither.
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
          icon={<MessageSquare aria-hidden="true" className="size-2.5" />}
          label={`${comments} open ${comments === 1 ? 'comment' : 'comments'}`}
          className="bg-yellow-400/25 text-yellow-800 dark:bg-yellow-400/20 dark:text-yellow-300"
        />
      ) : null}
      {suggestions > 0 ? (
        <CountBadge
          count={suggestions}
          icon={<Sparkles aria-hidden="true" className="size-2.5" />}
          label={`${suggestions} pending ${suggestions === 1 ? 'suggestion' : 'suggestions'}`}
          className="bg-amber-500/25 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
        />
      ) : null}
    </>
  );
}
