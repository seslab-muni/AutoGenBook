import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { CheckCheck, MessageSquarePlus } from 'lucide-react';

import { useCreateCommentMutation } from '@/api/queries/comments';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { TextRange } from '@/features/editor/lib/anchors';
import { cn } from '@/lib/utils';
import type { MarginCardContext } from './card-registry';
import { CommentComposer } from './comment-composer';
import type { MarginGeometry } from './geometry';
import { MarginCard } from './margin-card';
import { layoutMargin, type LayoutItem } from './margin-layout';
import { DRAFT_ID, useMarginStore, type ComposerDraft } from './margin-store';
import { isClosed, type MarginFilter, type MarginThread } from './threads';

const DEFAULT_CARD_HEIGHT = 120;
const CARD_GAP = 8;
const FILTERS: { value: MarginFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'comment', label: 'Comments' },
  { value: 'suggestion', label: 'Suggestions' },
  { value: 'review', label: 'Review' },
];

interface MarginPanelProps {
  ctx: MarginCardContext;
  /** Every thread of the section (for the resolved count)... */
  threads: readonly MarginThread[];
  /** ...and the ones the filter lets through, in display order. */
  visible: readonly MarginThread[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  composer: ComposerDraft | null;
  /** Where the composer's anchor sits in the text right now. */
  composerRange: TextRange | null;
  composerQuote: string;
  /** Null while the text pane is not mounted yet. */
  geometry: MarginGeometry | null;
}

/** Fires `callback` once per animation frame at most, however often it is requested. */
function useFrameScheduler(callback: () => void): () => void {
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  });
  const frame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  return useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      callbackRef.current();
    });
  }, []);
}

function sameMap(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (Math.abs((b.get(key) ?? NaN) - value) > 0.5) return false;
  return true;
}

/**
 * The margin: a filter header and the cards, each beside the text it is about. Cards are placed
 * by `layoutMargin` from two measurements, both batched per animation frame and never made while
 * typing: the y of each anchor (from the text pane's `MarginGeometry`) and each card's height
 * (one `ResizeObserver`). The lane scrolls natively and mirrors the text pane's scroll position
 * (and the reverse), so scrolling moves no cards and triggers no layout.
 */
export function MarginPanel({
  ctx,
  threads,
  visible,
  loading,
  error,
  onRetry,
  composer,
  composerRange,
  composerQuote,
  geometry,
}: MarginPanelProps) {
  const filter = useMarginStore((state) => state.filter);
  const showResolved = useMarginStore((state) => state.showResolved);
  const focusedId = useMarginStore((state) => state.focusedId);
  const setFilter = useMarginStore((state) => state.setFilter);
  const setShowResolved = useMarginStore((state) => state.setShowResolved);
  const focus = useMarginStore((state) => state.focus);
  const openComposer = useMarginStore((state) => state.openComposer);
  const closeComposer = useMarginStore((state) => state.closeComposer);
  const create = useCreateCommentMutation(ctx.projectId, ctx.nodeId);

  const closedCount = useMemo(() => threads.filter(isClosed).length, [threads]);

  // ---- measurements -------------------------------------------------------------------
  const [anchorY, setAnchorY] = useState<ReadonlyMap<string, number>>(new Map());
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const pendingHeights = useRef(new Map<string, number>());
  const elements = useRef(new Map<string, HTMLElement>());
  const viewport = useRef<HTMLDivElement>(null);

  const anchored = useMemo(
    () => [
      ...visible
        .filter((thread) => thread.range)
        .map((thread) => ({ id: thread.id, start: thread.range!.start })),
      ...(composer && composerRange ? [{ id: DRAFT_ID, start: composerRange.start }] : []),
    ],
    [visible, composer, composerRange],
  );
  const anchoredKey = anchored.map((anchor) => `${anchor.id}:${anchor.start}`).join('|');

  const measure = useFrameScheduler(() => {
    if (!geometry) return;
    const next = geometry.measure(anchored);
    setAnchorY((previous) => (sameMap(previous, next) ? previous : next));
  });
  const commitHeights = useFrameScheduler(() => {
    setHeights(new Map(pendingHeights.current));
  });

  useLayoutEffect(() => {
    measure();
  }, [measure, geometry, anchoredKey, visible.length]);

  useEffect(() => {
    if (!geometry) return undefined;
    return geometry.subscribe(measure);
  }, [geometry, measure]);

  // One observer for every card's height.
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    const instance = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset['threadId'] ?? DRAFT_ID;
        const height = (entry.target as HTMLElement).offsetHeight;
        if (pendingHeights.current.get(id) !== height) {
          pendingHeights.current.set(id, height);
          changed = true;
        }
      }
      if (changed) commitHeights();
    });
    observer.current = instance;
    for (const element of elements.current.values()) instance.observe(element);
    return () => {
      instance.disconnect();
      observer.current = null;
    };
  }, [commitHeights]);

  const registerCard = useCallback(
    (id: string) => (element: HTMLElement | null) => {
      const previous = elements.current.get(id);
      if (previous && previous !== element) observer.current?.unobserve(previous);
      if (element) {
        elements.current.set(id, element);
        observer.current?.observe(element);
      } else {
        elements.current.delete(id);
        pendingHeights.current.delete(id);
      }
    },
    [],
  );

  // ---- layout -------------------------------------------------------------------------
  const ordered = useMemo(() => {
    const items: { id: string; draft: boolean; thread?: MarginThread; placed: boolean }[] = [];
    if (composer && composer.anchor === null) {
      items.push({ id: DRAFT_ID, draft: true, placed: false });
    }
    for (const thread of visible) {
      if (!thread.range) items.push({ id: thread.id, draft: false, thread, placed: false });
    }
    // The composer for a selection sits among the anchored cards at the selection.
    for (const thread of visible) {
      if (thread.range) {
        items.push({ id: thread.id, draft: false, thread, placed: anchorY.has(thread.id) });
      }
    }
    if (composer && composer.anchor !== null) {
      items.push({ id: DRAFT_ID, draft: true, placed: anchorY.has(DRAFT_ID) });
    }
    return items;
  }, [visible, composer, anchorY]);

  const tops = useMemo(() => {
    const layoutItems: LayoutItem[] = ordered.map((item) => ({
      id: item.id,
      y: item.placed ? (anchorY.get(item.id) ?? 0) : 0,
      height: heights.get(item.id) ?? DEFAULT_CARD_HEIGHT,
    }));
    return {
      map: layoutMargin(layoutItems, { gap: CARD_GAP, focusedId }),
      items: layoutItems,
    };
  }, [ordered, anchorY, focusedId, heights]);

  const extent = useMemo(() => {
    let bottom = 0;
    for (const item of tops.items) {
      bottom = Math.max(bottom, (tops.map.get(item.id) ?? 0) + item.height);
    }
    return bottom + 24;
  }, [tops]);

  // ---- scroll mirroring ---------------------------------------------------------------
  useEffect(() => {
    const lane = viewport.current;
    const text = geometry?.scrollEl;
    if (!lane || !text) return undefined;
    const textMax = () => text.scrollHeight - text.clientHeight;
    const fromText = () => {
      // When the margin is longer than the text, do not pull it back to the text's end.
      if (text.scrollTop >= textMax() - 0.5 && lane.scrollTop >= text.scrollTop) return;
      if (Math.abs(lane.scrollTop - text.scrollTop) > 0.5) lane.scrollTop = text.scrollTop;
    };
    const fromLane = () => {
      if (lane.scrollTop <= textMax() && Math.abs(text.scrollTop - lane.scrollTop) > 0.5) {
        text.scrollTop = lane.scrollTop;
      }
    };
    text.addEventListener('scroll', fromText, { passive: true });
    lane.addEventListener('scroll', fromLane, { passive: true });
    fromText();
    return () => {
      text.removeEventListener('scroll', fromText);
      lane.removeEventListener('scroll', fromLane);
    };
  }, [geometry, extent]);

  // ---- focus: reveal the focused card in the margin, its text in the pane ----------------
  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads],
  );
  useEffect(() => {
    if (!focusedId) return;
    const element = elements.current.get(focusedId);
    const lane = viewport.current;
    if (element && lane) {
      const top = element.offsetTop;
      const bottom = top + element.offsetHeight;
      if (top < lane.scrollTop) lane.scrollTop = Math.max(0, top - 12);
      else if (bottom > lane.scrollTop + lane.clientHeight) {
        lane.scrollTop = bottom - lane.clientHeight + 12;
      }
    }
  }, [focusedId, tops]);

  const handleFocusCard = useCallback(
    (id: string) => {
      focus(id);
      const thread = threadById.get(id);
      if (thread?.range) geometry?.reveal(id, thread.range.start);
    },
    [focus, geometry, threadById],
  );

  const empty = !loading && !error && visible.length === 0 && !composer;

  return (
    <aside aria-label="Margin" className="flex h-full min-h-0 flex-col bg-muted">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b px-3">
        <ToggleGroup
          aria-label="Filter margin cards"
          value={filter}
          onValueChange={(value) => setFilter(value as MarginFilter)}
          className="h-7 bg-background/60"
        >
          {FILTERS.map(({ value, label }) => (
            <ToggleGroupItem key={value} value={value} className="px-2 text-xs">
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant={showResolved ? 'secondary' : 'ghost'}
                size="icon-sm"
                aria-label={`Show resolved (${closedCount})`}
                aria-pressed={showResolved}
                onClick={() => setShowResolved(!showResolved)}
              >
                <CheckCheck />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {showResolved ? 'Hide' : 'Show'} resolved ({closedCount})
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Comment on the whole section"
                onClick={() => openComposer(null)}
              >
                <MessageSquarePlus />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Comment on the whole section</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div
        ref={viewport}
        role="region"
        aria-label="Margin cards"
        tabIndex={-1}
        className="custom-scrollbar relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {error ? (
          <p role="alert" className="p-4 text-sm text-destructive">
            Couldn&apos;t load the comments.{' '}
            <Button type="button" variant="link" size="xs" className="h-auto p-0" onClick={onRetry}>
              Retry
            </Button>
          </p>
        ) : null}
        {loading ? <p className="p-4 text-sm text-muted-foreground">Loading comments…</p> : null}
        {empty ? (
          <p className="p-4 text-sm text-muted-foreground">
            {closedCount > 0 && filter === 'all' && !showResolved
              ? `All ${closedCount} comment ${closedCount === 1 ? 'thread is' : 'threads are'} resolved.`
              : 'No comments yet. Select some text and choose Comment, or comment on the whole section.'}
          </p>
        ) : null}

        <div className={cn('relative', empty && 'hidden')} style={{ height: extent }}>
          {ordered.map((item) => {
            if (item.draft && composer) {
              return (
                <DraftCard
                  key={DRAFT_ID}
                  ref={registerCard(DRAFT_ID)}
                  top={tops.map.get(DRAFT_ID)}
                  quote={composer.anchor ? composerQuote : null}
                  busy={create.isPending}
                  onCancel={() => {
                    closeComposer();
                    ctx.restoreEditorFocus();
                  }}
                  onSubmit={(text) => {
                    create.mutate(
                      {
                        bodyMarkdown: text,
                        anchor: composer.anchor,
                      },
                      {
                        onSuccess: (comment) => focus(comment.id),
                      },
                    );
                    closeComposer();
                    ctx.restoreEditorFocus();
                  }}
                />
              );
            }
            if (!item.thread) return null;
            return (
              <MarginCard
                key={item.id}
                ref={registerCard(item.id)}
                thread={item.thread}
                ctx={ctx}
                top={tops.map.get(item.id)}
                focused={focusedId === item.id}
                onFocusCard={handleFocusCard}
              />
            );
          })}
        </div>
      </div>
    </aside>
  );
}

const DraftCard = forwardRef<
  HTMLElement,
  {
    top: number | undefined;
    quote: string | null;
    busy: boolean;
    onSubmit: (text: string) => void;
    onCancel: () => void;
  }
>(function DraftCard({ top, quote, busy, onSubmit, onCancel }, ref) {
  return (
    <section
      ref={ref}
      aria-label="New comment"
      data-kind="draft"
      data-focused
      className={cn(
        '@container absolute inset-x-3 rounded-lg border border-ring bg-card p-3 text-card-foreground shadow-md',
        top === undefined && 'invisible',
      )}
      style={{ top: top ?? 0 }}
    >
      {quote ? (
        <blockquote className="mb-2 line-clamp-3 border-l-2 pl-2 text-xs text-muted-foreground italic">
          {quote}
        </blockquote>
      ) : (
        <p className="mb-2 text-xs text-muted-foreground">On the whole section</p>
      )}
      <CommentComposer label="New comment" busy={busy} onSubmit={onSubmit} onCancel={onCancel} />
    </section>
  );
});
