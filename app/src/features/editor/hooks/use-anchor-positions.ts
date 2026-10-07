import { useState } from 'react';

import {
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

function resolveAll(items: readonly AnchorItem[], text: string): AnchorPositions {
  const positions = new Map<string, TextRange | null>();
  for (const item of items) {
    positions.set(item.id, item.anchor ? resolveAnchorUnits(text, item.anchor) : null);
  }
  return positions;
}

function mapAll(positions: AnchorPositions, before: string, after: string): AnchorPositions {
  const change = diffChange(before, after);
  if (!change) return positions;
  const next = new Map<string, TextRange | null>();
  for (const [id, range] of positions) {
    next.set(id, range ? mapRangeThroughChange(range, change) : null);
  }
  return next;
}

/**
 * Where each anchor sits in the live `text` (UTF-16 offsets), kept right while the section is open:
 *
 * - a new `items` list (comments loaded or refetched, another user's reply, a save that made the
 *   server re-anchor) re-resolves every anchor from its quote against the current text;
 * - an edit to `text` maps each position through the change (single span, found by trimming the
 *   common prefix and suffix), so a highlight follows its words while typing and an anchor whose
 *   words were deleted becomes `null` (orphaned) at once.
 *
 * `items` must be memoised by the caller. Computed during render (no effect lag, no flash of
 * stale highlights), the way React recommends for state derived from props.
 */
export function useAnchorPositions(items: readonly AnchorItem[], text: string): AnchorPositions {
  const [state, setState] = useState(() => ({ items, text, positions: resolveAll(items, text) }));
  if (state.items !== items) {
    const next = { items, text, positions: resolveAll(items, text) };
    setState(next);
    return next.positions;
  }
  if (state.text !== text) {
    const next = { items, text, positions: mapAll(state.positions, state.text, text) };
    setState(next);
    return next.positions;
  }
  return state.positions;
}
