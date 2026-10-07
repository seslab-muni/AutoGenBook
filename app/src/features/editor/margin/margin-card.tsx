import { forwardRef, memo } from 'react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { cardKind, type MarginCardContext } from './card-registry';
import type { MarginThread } from './threads';

interface MarginCardProps {
  thread: MarginThread;
  ctx: MarginCardContext;
  /** Pixel offset from the top of the margin lane; `undefined` before the first layout. */
  top: number | undefined;
  focused: boolean;
  onFocusCard: (id: string) => void;
}

/** Short label for the card region, read by screen readers: "Comment by Ada on “quote”". */
function describeCard(thread: MarginThread, label: string): string {
  const author = thread.root.authorName;
  const head = `${label}${author ? ` by ${author}` : ''}`;
  if (thread.sectionLevel) return `${head} on the whole section`;
  const quote = thread.quote.length > 60 ? `${thread.quote.slice(0, 60)}…` : thread.quote;
  return `${head}${thread.orphaned ? ' (orphaned)' : ''} on “${quote}”`;
}

/**
 * The frame every margin card shares: absolute position, focus ring, header (kind, status), the
 * quoted text, and the kind-specific body from `MARGIN_CARD_KINDS`. A focusable region: Tab
 * reaches it, and focusing anything inside it focuses the card (and so its highlight).
 */
const MarginCardInner = forwardRef<HTMLElement, MarginCardProps>(function MarginCard(
  { thread, ctx, top, focused, onFocusCard },
  ref,
) {
  const { label, icon: Icon, Body } = cardKind(thread.kind);
  const closed = thread.status === 'resolved';

  return (
    <section
      ref={ref}
      data-thread-id={thread.id}
      data-kind={thread.kind}
      data-focused={focused || undefined}
      aria-label={describeCard(thread, label)}
      tabIndex={0}
      onFocus={() => onFocusCard(thread.id)}
      onClick={() => onFocusCard(thread.id)}
      className={cn(
        '@container absolute inset-x-3 rounded-lg border bg-card p-3 text-card-foreground shadow-xs outline-none',
        'transition-[top,box-shadow] duration-150 motion-reduce:transition-none',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50',
        focused && 'border-ring shadow-md',
        closed && 'bg-card/70',
        top === undefined && 'invisible',
      )}
      style={{ top: top ?? 0 }}
    >
      <header className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
          {label}
        </span>
        <span className="flex items-center gap-1">
          {thread.orphaned ? <Badge variant="outline">Orphaned</Badge> : null}
          {thread.sectionLevel ? <Badge variant="outline">Whole section</Badge> : null}
          {closed ? <Badge variant="secondary">Resolved</Badge> : null}
        </span>
      </header>
      {!thread.sectionLevel && thread.quote ? (
        <blockquote
          className={cn(
            'mb-2 line-clamp-3 border-l-2 pl-2 text-xs text-muted-foreground italic',
            thread.orphaned && 'line-through decoration-muted-foreground/60',
          )}
        >
          {thread.quote}
        </blockquote>
      ) : null}
      {thread.orphaned ? (
        <p className="mb-2 text-[11px] text-muted-foreground">
          The text this refers to is gone from the section.
        </p>
      ) : null}
      <Body thread={thread} ctx={ctx} />
    </section>
  );
});

/**
 * Typing shifts every anchor after the caret, which changes each thread's `range` but nothing a
 * card shows, so cards compare only what they render (plus the stable query rows).
 */
export const MarginCard = memo(MarginCardInner, (a, b) => {
  const x = a.thread;
  const y = b.thread;
  return (
    a.top === b.top &&
    a.focused === b.focused &&
    a.ctx === b.ctx &&
    a.onFocusCard === b.onFocusCard &&
    x.root === y.root &&
    x.replies.length === y.replies.length &&
    x.replies.every((reply, i) => reply === y.replies[i]) &&
    x.status === y.status &&
    x.orphaned === y.orphaned &&
    x.sectionLevel === y.sectionLevel &&
    x.quote === y.quote
  );
});
