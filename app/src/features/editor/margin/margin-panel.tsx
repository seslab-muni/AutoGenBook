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
import { cardRegionName } from './card-name';
import { MarginCard } from './margin-card';
import { ReviewSummaryStrip } from './review-summary-strip';
import type { ReviewSummary } from '@/features/editor/lib/card-payloads';
import { extraBottom, layoutMargin, type LayoutItem } from './margin-layout';
import { DRAFT_ID, useMarginStore, type ComposerDraft } from './margin-store';
import { isThreadClosed, type MarginFilter, type MarginThread } from './threads';

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
  /** The section's latest review verdict (`OutlineNode.reviewSummary`); shown with the All and Review filters. */
  reviewSummary?: ReviewSummary | null | undefined;
  reviewerScore?: number | null | undefined;
  /** Notes of a review from before review rows existed (`reviewerNotes`), shown only when there is no summary. */
  legacyNotes?: string | null | undefined;
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
  reviewSummary = null,
  reviewerScore = null,
  legacyNotes = null,
  anchorNote,
}: MarginPanelProps) {
  const filter = useMarginStore((state) => state.filter);
  const showResolved = useMarginStore((state) => state.showResolved);
  const focusedId = useMarginStore((state) => state.focusedId);
  const focusRequest = useMarginStore((state) => state.focusRequest);
  const revealRequest = useMarginStore((state) => state.revealRequest);
  const setFilter = useMarginStore((state) => state.setFilter);
  const setShowResolved = useMarginStore((state) => state.setShowResolved);
  const focus = useMarginStore((state) => state.focus);
  const openComposer = useMarginStore((state) => state.openComposer);

  const showStrip =
    (reviewSummary !== null || !!legacyNotes) && (filter === 'all' || filter === 'review');
  const closedCount = useMemo(() => threads.filter(isThreadClosed).length, [threads]);

  // ---- measurements -------------------------------------------------------------------
  const [measures, setMeasures] = useState<ReadonlyMap<string, AnchorMeasure>>(new Map());
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  /** How far the text pane's top is above the lane's (the verdict header sits above the lane): cards stay clear of it. */
  const [inset, setInset] = useState(0);
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
      setInset(Math.max(0, Math.round(-laneOffset.current)));
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

  // The header above the lane changes height with the verdict; the lane then starts lower.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return undefined;
    const resize = new ResizeObserver(() => measure());
    resize.observe(element);
    return () => resize.disconnect();
  }, [measure]);

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

  /**
   * The card the layout keeps at its own y (the others make room around it). It is the focused card
   * when that card was focused deliberately (a click on the card, a highlight's focus request, a
   * reveal); a click on a control inside a card (Reply, Fix with Copilot, Accept) focuses the card
   * without snapping it, so nothing moves under the pointer.
   */
  const [snapId, setSnapId] = useState<string | null>(null);
  const tops = useMemo(() => {
    const layoutItems: LayoutItem[] = ordered.map((item) => ({
      id: item.id,
      y: item.placed ? (measures.get(item.id)?.y ?? 0) : 0,
      height: heights.get(item.id) ?? DEFAULT_CARD_HEIGHT,
    }));
    return {
      map: layoutMargin(layoutItems, { gap: CARD_GAP, focusedId: snapId, minTop: inset }),
      items: layoutItems,
    };
  }, [ordered, measures, snapId, heights, inset]);

  // Landmarks need distinct names: cards that would read the same ("Comment by Ada on “x”") are numbered.
  const suffixes = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const item of ordered) {
      if (!item.thread) continue;
      const name = cardRegionName(item.thread);
      groups.set(name, [...(groups.get(name) ?? []), item.id]);
    }
    const result = new Map<string, string>();
    for (const ids of groups.values()) {
      if (ids.length > 1) ids.forEach((id, i) => result.set(id, ` (${i + 1} of ${ids.length})`));
    }
    return result;
  }, [ordered]);

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
    return geometry.subscribe(apply);
  }, [geometry, extent]);
  // The extra space is removed only when the geometry itself goes away. Removing it on every
  // change of `extent` (and reading the height in between) let the browser clamp the scroll
  // position to the shorter content, so a card that grew under the reader's eyes (a suggestion
  // turning from progress into a diff) threw the text back to the top.
  useEffect(() => () => geometry?.setExtraBottom(0), [geometry]);

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

  // A focused card the lane has pushed out of sight (stacking moved it, or the text pane only just
  // got the extra space to reach it) is scrolled into view once the layout has settled.
  const revealRef = useRef<{ id: string; attempts: number } | null>(null);
  const [revealVersion, setRevealVersion] = useState(0);
  useEffect(() => {
    const pending = revealRef.current;
    if (!pending || !geometry) return undefined;
    const frame = requestAnimationFrame(() => {
      const element = elements.current.get(pending.id);
      const lane = viewport.current;
      if (!element || !lane || revealRef.current !== pending) return;
      const box = element.getBoundingClientRect();
      const view = lane.getBoundingClientRect();
      if (box.bottom > view.bottom - 8) {
        // Never scroll the card's own top out of view (a tall card is shown from its top). The focused
        // card keeps its own spot in the layout and the others make room around it, so this is
        // rarely more than a nudge and does not scroll the text away.
        const delta = Math.min(box.bottom - view.bottom + 24, box.top - view.top - 8);
        if (delta > 0) geometry.scrollBy(delta);
        else {
          revealRef.current = null;
          return;
        }
      } else if (box.top < view.top + 8) geometry.scrollBy(box.top - view.top - 24);
      else {
        revealRef.current = null;
        return;
      }
      pending.attempts += 1;
      if (pending.attempts >= 6) revealRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [tops, extent, geometry, revealVersion]);

  /** The panel asked for a card to be brought to its text: snap it there and scroll it into view. */
  const revealCard = useCallback(
    (id: string) => {
      focus(id);
      setSnapId(id);
      revealRef.current = { id, attempts: 0 };
      setRevealVersion((version) => version + 1);
      const thread = threadsRef.current.find((candidate) => candidate.id === id);
      if (thread?.range) geometry?.reveal(id, thread.range.start);
    },
    [focus, geometry],
  );

  /** Set while the panel itself moves keyboard focus into a card: that focus is not a person's. */
  const programmaticFocus = useRef(false);

  /**
   * A person focused a card. A click on the card itself (or Tab onto it) snaps it to its text the
   * way a reveal does, but keeps it where it is on screen: the text pane is scrolled by exactly the
   * displacement the snap would cause, so the text comes level with the card and nothing moves under
   * the pointer. A click on a control inside a card only focuses it: no snap, no scroll.
   */
  // Read through refs: the handler is a prop of every (memoised) card, so it must not change with
  // the layout, which changes on every keystroke.
  const layoutRef = useRef({ tops, inset, snapId });
  useLayoutEffect(() => {
    layoutRef.current = { tops, inset, snapId };
  }, [tops, inset, snapId]);
  const handleFocusCard = useCallback(
    (id: string, source: 'card' | 'control') => {
      if (programmaticFocus.current) {
        revealCard(id);
        return;
      }
      const layout = layoutRef.current;
      if (source === 'card' && id !== layout.snapId) {
        const current = layout.tops.map.get(id);
        const landing = layoutMargin(layout.tops.items, {
          gap: CARD_GAP,
          focusedId: id,
          minTop: layout.inset,
        }).get(id);
        if (geometry && current !== undefined && landing !== undefined && landing !== current) {
          geometry.scrollBy(landing - current);
          applyTransform();
        }
        setSnapId(id);
      }
      focus(id);
    },
    [focus, geometry, revealCard, applyTransform],
  );

  // A request to move keyboard focus into a card (a highlight's shortcut).
  const handledNonce = useRef(0);
  useEffect(() => {
    if (!focusRequest || focusRequest.nonce === handledNonce.current) return;
    const element = elements.current.get(focusRequest.id);
    if (!element) return;
    handledNonce.current = focusRequest.nonce;
    programmaticFocus.current = true;
    try {
      element.focus();
    } finally {
      programmaticFocus.current = false;
    }
  }, [focusRequest, tops]);

  // A request to bring a card into view without taking keyboard focus (a suggestion just started
  // from a chip or a review card, which may sit below the fold). The card the person is working in
  // (focused: they pressed Fix with Copilot or Send to Copilot in it, or mentioned @copilot in its
  // composer) and a card already in view are left where they are - they are being looked at, and
  // snapping or scrolling them would only be a jump.
  const handledReveal = useRef(0);
  useEffect(() => {
    if (!revealRequest || revealRequest.nonce === handledReveal.current) return;
    const element = elements.current.get(revealRequest.id);
    const lane = viewport.current;
    if (!element || !lane) return;
    handledReveal.current = revealRequest.nonce;
    if (revealRequest.id === focusedId) return;
    const box = element.getBoundingClientRect();
    const view = lane.getBoundingClientRect();
    if (box.top >= view.top - 1 && box.bottom <= view.bottom + 1) focus(revealRequest.id);
    else revealCard(revealRequest.id);
  }, [revealRequest, tops, focusedId, focus, revealCard]);

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
        <p className="border-b px-3 py-2 text-xs text-foreground">{anchorNote}</p>
      ) : null}

      {showStrip ? (
        <ReviewSummaryStrip
          summary={reviewSummary}
          threads={threads}
          score={reviewerScore}
          legacyNotes={legacyNotes}
        />
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
          <p role="alert" className="p-4 text-sm text-destructive-text">
            Couldn&apos;t load the comments.{' '}
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto p-0 text-foreground"
              onClick={onRetry}
            >
              Retry
            </Button>
          </p>
        ) : null}
        {loading ? <p className="p-4 text-sm text-foreground">Loading comments…</p> : null}
        {empty ? (
          <p className="p-4 text-sm text-foreground">
            {closedCount > 0 && filter === 'all' && !showResolved
              ? `All ${closedCount} ${closedCount === 1 ? 'card is' : 'cards are'} resolved.`
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
                  threads={threads}
                  range={composerRange}
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
                labelSuffix={suffixes.get(item.id) ?? ''}
              />
            );
          })}
        </div>
      </div>
    </aside>
  );
}
