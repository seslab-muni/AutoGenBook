import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  anchorFromUnitRange,
  diffChange,
  mapRangeThroughChange,
  resolveAnchorUnits,
  type AnchorInput,
  type TextRange,
} from '@/features/editor/lib/anchors';

export interface AnchorItem {
  id: string;
  /** `null` = a section-level card with nothing to locate. */
  anchor: AnchorInput | null;
}

export type AnchorPositions = ReadonlyMap<string, TextRange | null>;

interface State {
  items: readonly AnchorItem[];
  text: string;
  resetKey: number;
  positions: AnchorPositions;
  /** Ids of items that have an anchor at all (section-level ones can never be orphaned). */
  anchored: ReadonlySet<string>;
  /** Anchors the slow search has already failed to place: shown as orphaned, searched for again quietly. */
  settled: ReadonlySet<string>;
}

interface Options {
  /**
   * `cm`: the Source view's decoration field maps positions through real change sets and reports
   * them with `reportMapped`; text changes are not diffed. `diff`: positions are mapped through
   * the single span that differs between the old and the new text (the text only changes from
   * outside there: another user's content, an accepted suggestion).
   */
  mode: 'cm' | 'diff';
  /** Bump to say the text was replaced from outside: every anchor is re-resolved from its quote. */
  resetKey: number;
  /** Debounce before unplaced anchors are searched for again after the text changed. */
  retryMs?: number;
}

/** The cheap exact/whitespace resolution done while rendering; the fuzzy step runs later, off the render path. */
function resolveQuick(text: string, anchor: AnchorInput | null): TextRange | null {
  return anchor ? resolveAnchorUnits(text, anchor, { fuzzy: false }) : null;
}

function anchoredIds(items: readonly AnchorItem[]): Set<string> {
  return new Set(items.filter((item) => item.anchor).map((item) => item.id));
}

function resolveAll(items: readonly AnchorItem[], text: string): Map<string, TextRange | null> {
  return new Map(items.map((item) => [item.id, resolveQuick(text, item.anchor)]));
}

/**
 * Where each anchor sits in the live `text` (UTF-16 offsets), kept right while the section is open.
 *
 * - A new `items` list (comments loaded or refetched, a reply from someone else, a save after which
 *   the server re-anchored) re-resolves only the rows whose `anchor` object changed (react-query
 *   keeps identity for unchanged ones): rows that did not change keep their local position, so a
 *   refetch landing mid-edit never makes a card jump.
 * - In `diff` mode an edit maps positions through the changed span; an anchor the span swallows is
 *   not given up on but re-resolved from its quote.
 * - Anchors without a position are searched for again (fuzzy included) a moment after the text last
 *   changed, one at a time, never in render: so undoing a deletion brings the card back. Until that
 *   search has failed once they are `pending`, not orphaned.
 *
 * `items` must be memoised by the caller.
 */
export function useAnchorPositions(items: readonly AnchorItem[], text: string, options: Options) {
  const { mode, resetKey, retryMs = 350 } = options;
  const [state, setState] = useState<State>(() => ({
    items,
    text,
    resetKey,
    positions: resolveAll(items, text),
    anchored: anchoredIds(items),
    settled: new Set(),
  }));

  // Derived during render (no frame of stale highlights), the way React recommends.
  let current = state;
  if (state.resetKey !== resetKey) {
    current = {
      items,
      text,
      resetKey,
      positions: resolveAll(items, text),
      anchored: anchoredIds(items),
      settled: new Set(),
    };
  } else if (state.items !== items) {
    const previous = new Map(state.items.map((item) => [item.id, item]));
    const positions = new Map<string, TextRange | null>();
    const settled = new Set<string>();
    for (const item of items) {
      const before = previous.get(item.id);
      if (before && before.anchor === item.anchor && state.positions.has(item.id)) {
        positions.set(item.id, state.positions.get(item.id) ?? null);
        if (state.settled.has(item.id)) settled.add(item.id);
      } else {
        positions.set(item.id, resolveQuick(text, item.anchor));
      }
    }
    current = { ...state, items, text, positions, anchored: anchoredIds(items), settled };
  } else if (state.text !== text) {
    let positions = state.positions;
    if (mode === 'diff') {
      const change = diffChange(state.text, text);
      const mapped = new Map<string, TextRange | null>();
      for (const [id, range] of state.positions) {
        mapped.set(id, range && change ? mapRangeThroughChange(range, change) : range);
      }
      positions = mapped;
    }
    // (In `cm` mode the editor reports positions itself.)
    current = { ...state, text, positions };
  }
  if (current !== state) setState(current);

  /** The Source view's field says where every tracked range is now (`null` = deleted by an edit). */
  const reportMapped = useCallback((mapped: ReadonlyMap<string, TextRange | null>) => {
    setState((previous) => {
      let changed = false;
      const positions = new Map(previous.positions);
      for (const [id, range] of mapped) {
        if (!positions.has(id)) continue;
        const before = positions.get(id) ?? null;
        if (before?.start === range?.start && before?.end === range?.end) continue;
        changed = true;
        positions.set(id, range);
      }
      return changed ? { ...previous, positions } : previous;
    });
  }, []);

  const unlocated = useMemo(() => {
    const ids: string[] = [];
    for (const [id, range] of current.positions) {
      if (range === null && current.anchored.has(id)) ids.push(id);
    }
    return ids.sort();
  }, [current.positions, current.anchored]);

  // While an anchor is located, remember what it looks like *now* (quote and surrounding text, as
  // edited): the server's copy goes stale as the user types around it, and a later deletion and undo
  // is searched for with the fresh one. Debounced like the retry below, never per keystroke.
  const lastGood = useRef(new Map<string, { source: AnchorInput | null; anchor: AnchorInput }>());
  const latest = useRef(current);
  useEffect(() => {
    latest.current = current;
  });
  useEffect(() => {
    const timer = setTimeout(() => {
      const { positions, items: list, text: now } = latest.current;
      for (const item of list) {
        const range = positions.get(item.id);
        if (!item.anchor || !range) continue;
        lastGood.current.set(item.id, {
          source: item.anchor,
          anchor: anchorFromUnitRange(now, range.start, range.end),
        });
      }
    }, retryMs);
    return () => clearTimeout(timer);
  }, [current.text, current.positions, retryMs]);

  // Search again for anchors that have no position, once the text has settled.
  const triedRef = useRef(new Map<string, string>());
  const unlocatedKey = unlocated.join('|');
  const textNow = current.text;
  const itemsNow = current.items;
  useEffect(() => {
    if (unlocated.length === 0) return undefined;
    const queue = [...unlocated];
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      const id = queue.shift();
      if (cancelled || id === undefined) return;
      const item = itemsNow.find((candidate) => candidate.id === id);
      if (item?.anchor && triedRef.current.get(id) !== textNow) {
        triedRef.current.set(id, textNow);
        // The server's copy may have gone stale around the user's edits (or have just been orphaned by
        // a save): prefer what the located anchor looked like last, unless the server placed it afresh.
        const remembered = lastGood.current.get(id);
        const serverPlacedIt = remembered?.source !== item.anchor && item.anchor.start != null;
        const anchor = remembered && !serverPlacedIt ? remembered.anchor : item.anchor;
        const range = resolveAnchorUnits(textNow, anchor);
        setState((previous) => {
          if (previous.text !== textNow) return previous;
          const positions = new Map(previous.positions);
          const settled = new Set(previous.settled);
          if (range) {
            positions.set(id, range);
            settled.delete(id);
          } else settled.add(id);
          return { ...previous, positions, settled };
        });
      }
      timer = setTimeout(run, 0);
    };
    timer = setTimeout(run, retryMs);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
    // The key restarts the search only when the set of unplaced anchors or the text changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocatedKey, textNow, retryMs]);

  const pending = useMemo(
    () => new Set(unlocated.filter((id) => !current.settled.has(id))),
    [unlocated, current.settled],
  );

  return {
    positions: current.positions as AnchorPositions,
    /** Anchors with no position *yet*: a slower search is still due, so they are not known to be orphaned. */
    pending: pending as ReadonlySet<string>,
    reportMapped,
  };
}
