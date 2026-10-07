export interface LayoutItem {
  id: string;
  /** Where the card wants to be: the y of its anchor's first line. */
  y: number;
  height: number;
}

export interface LayoutOptions {
  /** Space between stacked cards. */
  gap?: number;
  /** The focused card keeps its own y and the others make room around it. */
  focusedId?: string | null;
  /** Nothing is placed above this. */
  minTop?: number;
}

/**
 * Google-Docs-style stacking: cards sorted by `y` sit at their anchor, each pushed down just
 * enough to clear the one above. With a focused card, it stays at its own `y` and the cards before
 * it are pushed up instead (never past `minTop`; if that would not fit, the plain top-down layout
 * is used). Pure: positions in, tops out. Input order breaks ties between equal `y`.
 */
export function layoutMargin(
  items: readonly LayoutItem[],
  { gap = 8, focusedId = null, minTop = 0 }: LayoutOptions = {},
): Map<string, number> {
  const sorted = items
    .map((item, order) => ({ item, order }))
    .sort((a, b) => a.item.y - b.item.y || a.order - b.order)
    .map(({ item }) => item);

  const tops = new Array<number>(sorted.length);
  let cursor = minTop;
  sorted.forEach((item, i) => {
    tops[i] = Math.max(item.y, cursor);
    cursor = tops[i]! + item.height + gap;
  });

  const focusedIndex = focusedId === null ? -1 : sorted.findIndex((item) => item.id === focusedId);
  if (focusedIndex >= 0) {
    const focused = sorted[focusedIndex]!;
    const anchoredTop = Math.max(focused.y, minTop);
    const alt = tops.slice();
    alt[focusedIndex] = anchoredTop;
    for (let i = focusedIndex - 1; i >= 0; i -= 1) {
      alt[i] = Math.min(tops[i]!, alt[i + 1]! - gap - sorted[i]!.height);
    }
    let next = anchoredTop + focused.height + gap;
    for (let i = focusedIndex + 1; i < sorted.length; i += 1) {
      alt[i] = Math.max(tops[i]!, next);
      next = alt[i]! + sorted[i]!.height + gap;
    }
    if (alt.every((top) => top >= minTop)) {
      return new Map(sorted.map((item, i) => [item.id, alt[i]!]));
    }
  }
  return new Map(sorted.map((item, i) => [item.id, tops[i]!]));
}
