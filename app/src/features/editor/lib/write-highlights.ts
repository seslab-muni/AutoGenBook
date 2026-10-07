import { alignValueToSource } from './source-map';

/** A range to highlight, in UTF-16 offsets over the author's Markdown. */
export interface HighlightRange {
  id: string;
  kind: string;
  start: number;
  end: number;
}

interface HighlightLike {
  priority: number;
  add(range: Range): void;
}
interface HighlightRegistryLike {
  set(name: string, highlight: HighlightLike): void;
  delete(name: string): void;
}

/**
 * The CSS Custom Highlight API paints ranges without touching the DOM, so highlighting (and
 * focusing) a comment never re-renders the Markdown or disturbs the user's text selection. Where
 * it is missing, `MarkdownView` falls back to wrapping the ranges in `<mark>` through rehype.
 */
export function supportsCustomHighlights(): boolean {
  const css = (typeof CSS !== 'undefined' ? CSS : undefined) as
    { highlights?: HighlightRegistryLike } | undefined;
  return (
    !!css?.highlights && typeof (globalThis as { Highlight?: unknown }).Highlight === 'function'
  );
}

const KINDS = ['comment', 'suggestion', 'review', 'draft', 'resolved'] as const;
const NAME = (kind: string) => `anchor-${kind}`;
const FOCUSED = 'anchor-focused';

interface Applied {
  ranges: Map<string, Range[]>;
  elements: Map<string, HTMLElement[]>;
}
const applied = new WeakMap<HTMLElement, Applied>();
const listeners = new Set<() => void>();

/** Notified whenever highlights were (re)applied, so the margin can re-measure. */
export function onHighlightsApplied(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The ranges and opaque elements currently highlighted for `id` under `root`. */
export function appliedFor(root: HTMLElement, id: string) {
  const entry = applied.get(root);
  return { ranges: entry?.ranges.get(id) ?? [], elements: entry?.elements.get(id) ?? [] };
}

interface Piece {
  el: HTMLElement;
  s: number;
  e: number;
}

function pieces(root: HTMLElement): Piece[] {
  const out: Piece[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('[data-src-start]')) {
    out.push({
      el,
      s: Number(el.getAttribute('data-src-start')),
      e: Number(el.getAttribute('data-src-end')),
    });
  }
  return out;
}

/** The characters of a tagged text piece that fall in `[start, end)` of the source, as a DOM range. */
function rangeInPiece(piece: Piece, markdown: string, start: number, end: number): Range | null {
  const text = piece.el.firstChild;
  if (!text || text.nodeType !== Node.TEXT_NODE || piece.el.childNodes.length !== 1) return null;
  const data = (text as Text).data;
  const range = document.createRange();
  if (start <= piece.s && end >= piece.e) {
    range.selectNodeContents(text);
    return range;
  }
  const map = alignValueToSource(data, markdown.slice(piece.s, piece.e));
  if (!map) {
    range.selectNodeContents(text);
    return range;
  }
  let lo = 0;
  while (lo < data.length && piece.s + map[lo]! < start) lo += 1;
  let hi = data.length;
  while (hi > lo && piece.s + map[hi - 1]! >= end) hi -= 1;
  if (hi <= lo) return null;
  range.setStart(text, lo);
  range.setEnd(text, hi);
  return range;
}

/**
 * Paints `highlights` over `root` (the rendered Markdown, tagged with `data-src-*` by
 * `rehypeAnchorSource`): one Custom Highlight per kind, plus a prioritised one for the focused
 * id. Opaque pieces (math, citation chips) cannot take a text range and get a `data-anchor-hit`
 * attribute instead. Returns a cleanup that removes everything again.
 */
export function applyWriteHighlights(
  root: HTMLElement,
  markdown: string,
  highlights: readonly HighlightRange[],
  focusedId: string | null,
): () => void {
  const registry = (CSS as unknown as { highlights: HighlightRegistryLike }).highlights;
  const HighlightCtor = (
    globalThis as unknown as { Highlight: new (...r: Range[]) => HighlightLike }
  ).Highlight;
  const all = pieces(root);
  const entry: Applied = { ranges: new Map(), elements: new Map() };
  const byKind = new Map<string, Range[]>();
  const focused: Range[] = [];
  const hits = new Map<HTMLElement, { ids: string[]; kind: string }>();

  for (const highlight of highlights) {
    // First tagged piece that could overlap (pieces are in document order, mostly source order).
    for (const piece of all) {
      if (piece.e <= highlight.start || piece.s >= highlight.end) continue;
      if (piece.el.hasAttribute('data-src-opaque')) {
        const hit = hits.get(piece.el) ?? { ids: [], kind: highlight.kind };
        hit.ids.push(highlight.id);
        hits.set(piece.el, hit);
        const list = entry.elements.get(highlight.id) ?? [];
        list.push(piece.el);
        entry.elements.set(highlight.id, list);
        continue;
      }
      const range = rangeInPiece(piece, markdown, highlight.start, highlight.end);
      if (!range) continue;
      const list = entry.ranges.get(highlight.id) ?? [];
      list.push(range);
      entry.ranges.set(highlight.id, list);
      const kindList = byKind.get(highlight.kind) ?? [];
      kindList.push(range);
      byKind.set(highlight.kind, kindList);
      if (highlight.id === focusedId) focused.push(range);
    }
  }

  for (const kind of KINDS) {
    const ranges = byKind.get(kind);
    if (ranges?.length) registry.set(NAME(kind), new HighlightCtor(...ranges));
    else registry.delete(NAME(kind));
  }
  if (focused.length) {
    const focusHighlight = new HighlightCtor(...focused);
    focusHighlight.priority = 10;
    registry.set(FOCUSED, focusHighlight);
  } else registry.delete(FOCUSED);

  for (const [el, hit] of hits) {
    el.setAttribute('data-anchor-hit', hit.ids.join(' '));
    el.setAttribute('data-anchor-kind', hit.kind);
    if (focusedId && hit.ids.includes(focusedId)) el.setAttribute('data-anchor-focused', '');
  }
  applied.set(root, entry);
  for (const listener of listeners) listener();

  return () => {
    for (const kind of KINDS) registry.delete(NAME(kind));
    registry.delete(FOCUSED);
    for (const el of hits.keys()) {
      el.removeAttribute('data-anchor-hit');
      el.removeAttribute('data-anchor-kind');
      el.removeAttribute('data-anchor-focused');
    }
    applied.delete(root);
  };
}

/** Ids of the highlights covering a collapsed caret at `(node, offset)` or a click on an opaque hit. */
export function highlightIdsAt(
  root: HTMLElement,
  node: Node | null,
  offset: number,
  target: EventTarget | null,
): string[] {
  const ids: string[] = [];
  if (target instanceof Element) {
    const hit = target.closest('[data-anchor-hit]');
    if (hit && root.contains(hit))
      ids.push(...(hit.getAttribute('data-anchor-hit') ?? '').split(' ').filter(Boolean));
  }
  const entry = applied.get(root);
  if (entry && node && root.contains(node)) {
    for (const [id, ranges] of entry.ranges) {
      if (ids.includes(id)) continue;
      if (ranges.some((range) => range.isPointInRange(node, offset))) ids.push(id);
    }
  }
  return ids;
}
