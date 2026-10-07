import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type TouchEvent,
  type WheelEvent,
} from 'react';
import { CheckCheck, MessageSquarePlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { TextRange } from '@/features/editor/lib/anchors';
import { cn } from '@/lib/utils';
import type { MarginCardContext } from './card-registry';
import { COMPOSER_KINDS } from './composer-registry';
import type { AnchorMeasure, MarginGeometry } from './geometry';
import { MarginCard } from './margin-card';
import { extraBottom, layoutMargin, type LayoutItem } from './margin-layout';
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
  /** Shown under the header when anchored comments are unavailable for this section (LaTeX). */
  anchorNote?: string | undefined;
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
      frame.current = null;
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

function sameMeasures(
  a: ReadonlyMap<string, AnchorMeasure>,
  b: ReadonlyMap<string, AnchorMeasure>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (!other || other.approximate !== value.approximate || Math.abs(other.y - value.y) > 0.5) {
      return false;
    }
  }
  return true;
}

/**
 * The margin: a filter header and the cards, each beside the text it is about. Cards are placed
 * by `layoutMargin` from two measurements, both batched per animation frame and never made while
 * typing beyond one read pass: the y of each anchor (from the text pane's `MarginGeometry`) and
 * each card's height (one `ResizeObserver`).
 *
 * The card lane does not scroll by itself: it is translated by the text pane's scroll position
 * (set straight on the element, no re-render), so nothing can feed back into the text pane. A
 * wheel over the lane, or the browser scrolling it to reveal a focused card, is forwarded to the
 * text pane instead.
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
  anchorNote,
}: MarginPanelProps) {
  const filter = useMarginStore((state) => state.filter);
  const showResolved = useMarginStore((state) => state.showResolved);
  const focusedId = useMarginStore((state) => state.focusedId);
  const focusRequest = useMarginStore((state) => state.focusRequest);
  const setFilter = useMarginStore((state) => state.setFilter);
  const setShowResolved = useMarginStore((state) => state.setShowResolved);
  const focus = useMarginStore((state) => state.focus);
  const openComposer = useMarginStore((state) => state.openComposer);

  const closedCount = useMemo(() => threads.filter(isClosed).length, [threads]);

  // ---- measurements -------------------------------------------------------------------
  const [measures, setMeasures] = useState<ReadonlyMap<string, AnchorMeasure>>(new Map());
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const pendingHeights = useRef(new Map<string, number>());
  const elements = useRef(new Map<string, HTMLElement>());
  const viewport = useRef<HTMLDivElement>(null);
  const lane = useRef<HTMLDivElement>(null);
  /** Screen offset of the text pane's top relative to the lane's top (their headers differ). */
  const laneOffset = useRef(0);

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

  const applyTransform = useCallback(() => {
    if (lane.current && geometry) {
      lane.current.style.transform = `translate3d(0, ${laneOffset.current - geometry.scrollTop()}px, 0)`;
    }
  }, [geometry]);

  const measure = useFrameScheduler(() => {
    if (!geometry) return;
    const next = geometry.measure(anchored);
    setMeasures((previous) => {
      // CodeMirror keeps revising its height estimate for lines it has not rendered, which moves
      // every far-away anchor a little on each viewport change. Re-laying out (and re-rendering)
      // 150 cards for that is wasted work nobody can see: anchors well away from the viewport keep
      // their last measure until the text is scrolled near them.
      const far = 3 * geometry.viewportHeight();
      const here = geometry.scrollTop();
      for (const [id, measure] of next) {
        const before = previous.get(id);
        if (before && Math.abs(before.y - here) > far && Math.abs(measure.y - here) > far) {
          next.set(id, before);
        }
      }
      return sameMeasures(previous, next) ? previous : next;
    });
    if (viewport.current) {
      laneOffset.current =
        geometry.scrollEl.getBoundingClientRect().top -
        viewport.current.getBoundingClientRect().top;
      applyTransform();
    }
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

  const registerCard = useCallback((id: string, element: HTMLElement | null) => {
    const previous = elements.current.get(id);
    if (previous && previous !== element) observer.current?.unobserve(previous);
    if (element) {
      elements.current.set(id, element);
      observer.current?.observe(element);
    } else {
      elements.current.delete(id);
      pendingHeights.current.delete(id);
    }
  }, []);

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
        items.push({ id: thread.id, draft: false, thread, placed: measures.has(thread.id) });
      }
    }
    if (composer && composer.anchor !== null) {
      items.push({ id: DRAFT_ID, draft: true, placed: measures.has(DRAFT_ID) });
    }
    return items;
  }, [visible, composer, measures]);

  const tops = useMemo(() => {
    const layoutItems: LayoutItem[] = ordered.map((item) => ({
      id: item.id,
      y: item.placed ? (measures.get(item.id)?.y ?? 0) : 0,
      height: heights.get(item.id) ?? DEFAULT_CARD_HEIGHT,
    }));
    return {
      map: layoutMargin(layoutItems, { gap: CARD_GAP, focusedId }),
      items: layoutItems,
    };
  }, [ordered, measures, focusedId, heights]);

  const extent = useMemo(() => {
    let bottom = 0;
    for (const item of tops.items) {
      bottom = Math.max(bottom, (tops.map.get(item.id) ?? 0) + item.height);
    }
    return bottom + 24;
  }, [tops]);

  // Cards stacked below the last line must stay reachable: let the text pane scroll that far. The
  // content height is not fixed (CodeMirror revises its estimate for lines it has not rendered, a
  // late image or KaTeX reflows), so it is recomputed whenever the geometry says the text moved.
  const extentRef = useRef(extent);
  useEffect(() => {
    extentRef.current = extent;
  }, [extent]);
  useEffect(() => {
    if (!geometry) return undefined;
    const apply = () =>
      geometry.setExtraBottom(extraBottom(extentRef.current, geometry.contentHeight()));
    apply();
    const stop = geometry.subscribe(apply);
    return () => {
      stop();
      geometry.setExtraBottom(0);
    };
  }, [geometry, extent]);

  // ---- scroll: the lane follows the text pane, never the other way round ---------------------
  useEffect(() => {
    const text = geometry?.scrollEl;
    if (!text) return undefined;
    text.addEventListener('scroll', applyTransform, { passive: true });
    applyTransform();
    return () => text.removeEventListener('scroll', applyTransform);
  }, [geometry, applyTransform]);

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (!geometry || event.ctrlKey) return;
      const unit =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? geometry.viewportHeight() : 1;
      geometry.scrollBy(event.deltaY * unit);
    },
    [geometry],
  );

  // A touch drag over the lane scrolls the text pane, the way a wheel does.
  const touchY = useRef<number | null>(null);
  const handleTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    touchY.current = event.touches[0]?.clientY ?? null;
  }, []);
  const handleTouchMove = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      const y = event.touches[0]?.clientY;
      if (!geometry || y === undefined || touchY.current === null) return;
      geometry.scrollBy(touchY.current - y);
      touchY.current = y;
    },
    [geometry],
  );

  // The browser may scroll the (clipped) lane to reveal a focused card: forward that to the text.
  const handleLaneScroll = useCallback(() => {
    const el = viewport.current;
    if (!el || !geometry || el.scrollTop === 0) return;
    const delta = el.scrollTop;
    el.scrollTop = 0;
    geometry.scrollBy(delta);
  }, [geometry]);

  // ---- focus ----------------------------------------------------------------------------------
  const threadsRef = useRef(threads);
  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  const handleFocusCard = useCallback(
    (id: string) => {
      focus(id);
      const thread = threadsRef.current.find((candidate) => candidate.id === id);
      if (thread?.range) geometry?.reveal(id, thread.range.start);
    },
    [focus, geometry],
  );

  // A request to move keyboard focus into a card (a highlight's shortcut).
  const handledNonce = useRef(0);
  useEffect(() => {
    if (!focusRequest || focusRequest.nonce === handledNonce.current) return;
    const element = elements.current.get(focusRequest.id);
    if (!element) return;
    handledNonce.current = focusRequest.nonce;
    element.focus();
  }, [focusRequest, tops]);

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
                onClick={() => openComposer({ kind: 'comment', anchor: null })}
              >
                <MessageSquarePlus />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Comment on the whole section</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {anchorNote ? (
        <p className="border-b px-3 py-2 text-xs text-muted-foreground">{anchorNote}</p>
      ) : null}

      <div
        ref={viewport}
        role="region"
        aria-label="Margin cards"
        className="relative min-h-0 flex-1 touch-none overflow-hidden"
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onScroll={handleLaneScroll}
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

        <div
          ref={lane}
          className={cn('absolute inset-x-0 top-0 will-change-transform', empty && 'hidden')}
          style={{ height: extent }}
        >
          {ordered.map((item) => {
            if (item.draft && composer) {
              const { Card } = COMPOSER_KINDS[composer.kind];
              return (
                <Card
                  key={DRAFT_ID}
                  draft={composer}
                  ctx={ctx}
                  register={registerCard}
                  top={tops.map.get(DRAFT_ID)}
                  quote={composer.anchor ? composerQuote : null}
                />
              );
            }
            if (!item.thread) return null;
            return (
              <MarginCard
                key={item.id}
                register={registerCard}
                thread={item.thread}
                ctx={ctx}
                top={tops.map.get(item.id)}
                focused={focusedId === item.id}
                approximate={measures.get(item.id)?.approximate ?? false}
                onFocusCard={handleFocusCard}
              />
            );
          })}
        </div>
      </div>
    </aside>
  );
}
