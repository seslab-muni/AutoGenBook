import { memo, useCallback } from 'react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { cardKind, type MarginCardContext, type MarginCardPartProps } from './card-registry';
import type { MarginThread } from './threads';

interface MarginCardProps {
  thread: MarginThread;
  ctx: MarginCardContext;
  /** Hands the card's element to the margin, which observes its height. */
  register: (id: string, element: HTMLElement | null) => void;
  /** Pixel offset from the top of the margin lane; `undefined` before the first layout. */
  top: number | undefined;
  focused: boolean;
  /** The anchor has no rendered highlight in the current view. */
  approximate?: boolean;
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

/** Default header status: where the card points and whether it is finished with. */
function DefaultStatus({ thread, approximate }: MarginCardPartProps) {
  return (
    <>
      {thread.orphaned ? <Badge variant="outline">Orphaned</Badge> : null}
      {thread.sectionLevel ? <Badge variant="outline">Whole section</Badge> : null}
      {approximate && !thread.orphaned ? (
        <Badge variant="outline">Not shown in this view</Badge>
      ) : null}
      {thread.status === 'resolved' ? <Badge variant="secondary">Resolved</Badge> : null}
    </>
  );
}

/** Default quote area: the quoted text, struck through when orphaned. */
function DefaultQuote({ thread }: MarginCardPartProps) {
  return (
    <>
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
    </>
  );
}

/**
 * The frame every margin card shares: absolute position, focus ring, header, quote area and body.
 * What goes in the header's status area, the quote area and the body comes from the card's kind in
 * `MARGIN_CARD_KINDS`. A focusable region: Tab reaches it, and focusing anything inside it focuses
 * the card (and so its highlight).
 */
function MarginCardInner({
  thread,
  ctx,
  register,
  top,
  focused,
  approximate = false,
  onFocusCard,
}: MarginCardProps) {
  const ref = useCallback(
    (element: HTMLElement | null) => register(thread.id, element),
    [register, thread.id],
  );
  const {
    label,
    icon: Icon,
    Status = DefaultStatus,
    Quote = DefaultQuote,
    Body,
  } = cardKind(thread.kind);
  const closed = thread.status === 'resolved';
  const part = { thread, ctx, approximate };

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
        <span className="flex flex-wrap items-center justify-end gap-1">
          <Status {...part} />
        </span>
      </header>
      <Quote {...part} />
      <Body {...part} />
    </section>
  );
}

/**
 * Typing shifts every anchor after the caret, which changes each thread's `range` but nothing a
 * card shows, so cards compare only what they render (plus the stable query rows).
 */
export const MarginCard = memo(MarginCardInner, (a, b) => {
  const x = a.thread;
  const y = b.thread;
  return (
    a.top === b.top &&
    a.register === b.register &&
    a.focused === b.focused &&
    a.approximate === b.approximate &&
    a.ctx === b.ctx &&
    a.onFocusCard === b.onFocusCard &&
    x.root === y.root &&
    x.replies.length === y.replies.length &&
    x.replies.every((reply, i) => reply === y.replies[i]) &&
    x.status === y.status &&
    x.orphaned === y.orphaned &&
    x.pending === y.pending &&
    x.sectionLevel === y.sectionLevel &&
    x.quote === y.quote
  );
});
