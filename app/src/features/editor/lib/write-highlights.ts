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

/** What each rendered Markdown (root) currently contributes to the document-wide highlight registry. */
interface Contribution {
  byKind: Map<string, Range[]>;
  focused: Range[];
}
const contributions = new Map<HTMLElement, Contribution>();

/**
 * The highlight registry is document-wide, and more than one `MarkdownView` can be mounted (the
 * export preview, the artifacts list, a reviewer's notes): each name is rebuilt from the union of
 * every root's ranges, so one instance applying (or cleaning up) never wipes another's.
 */
function rebuildRegistry(): void {
  const registry = (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights;
  if (!registry) return;
  const HighlightCtor = (
    globalThis as unknown as { Highlight: new (...r: Range[]) => HighlightLike }
  ).Highlight;
  for (const kind of KINDS) {
    const ranges = [...contributions.values()].flatMap((entry) => entry.byKind.get(kind) ?? []);
    if (ranges.length) registry.set(NAME(kind), new HighlightCtor(...ranges));
    else registry.delete(NAME(kind));
  }
  const focused = [...contributions.values()].flatMap((entry) => entry.focused);
  if (focused.length) {
    const highlight = new HighlightCtor(...focused);
    highlight.priority = 10;
    registry.set(FOCUSED, highlight);
  } else registry.delete(FOCUSED);
}

/** One highlight, already located in the DOM: text ranges, and opaque elements (math, chips, atoms) it touches. */
export interface LocatedHighlight {
  id: string;
  kind: string;
  ranges: Range[];
  elements: HTMLElement[];
}

/**
 * Puts located highlights on screen: one Custom Highlight per kind, plus a prioritised one for the
 * focused id, and `data-anchor-hit` on opaque elements. Shared by the read-only view (which locates
 * ranges through the `data-src-*` tags) and the editable view (which locates them through its
 * position map). Returns a cleanup that removes this root's contribution again.
 */
export function paintHighlights(
  root: HTMLElement,
  located: readonly LocatedHighlight[],
  focusedId: string | null,
): () => void {
  if (located.length === 0) return () => {};
  const entry: Applied = { ranges: new Map(), elements: new Map() };
  const contribution: Contribution = { byKind: new Map(), focused: [] };
  const hits = new Map<HTMLElement, { ids: string[]; kind: string }>();

  for (const highlight of located) {
    if (highlight.ranges.length > 0) entry.ranges.set(highlight.id, highlight.ranges);
    if (highlight.elements.length > 0) entry.elements.set(highlight.id, highlight.elements);
    for (const range of highlight.ranges) {
      const kindList = contribution.byKind.get(highlight.kind) ?? [];
      kindList.push(range);
      contribution.byKind.set(highlight.kind, kindList);
      if (highlight.id === focusedId) contribution.focused.push(range);
    }
    for (const el of highlight.elements) {
      const hit = hits.get(el) ?? { ids: [], kind: highlight.kind };
      hit.ids.push(highlight.id);
      hits.set(el, hit);
    }
  }

  contributions.set(root, contribution);
  rebuildRegistry();

  for (const [el, hit] of hits) {
    el.setAttribute('data-anchor-hit', hit.ids.join(' '));
    el.setAttribute('data-anchor-kind', hit.kind);
    if (focusedId && hit.ids.includes(focusedId)) el.setAttribute('data-anchor-focused', '');
  }
  applied.set(root, entry);
  for (const listener of listeners) listener();

  return () => {
    contributions.delete(root);
    rebuildRegistry();
    for (const el of hits.keys()) {
      el.removeAttribute('data-anchor-hit');
      el.removeAttribute('data-anchor-kind');
      el.removeAttribute('data-anchor-focused');
    }
    applied.delete(root);
  };
}

/**
 * Paints `highlights` over `root` (the rendered Markdown, tagged with `data-src-*` by
 * `rehypeAnchorSource`). Opaque pieces (math, citation chips) cannot take a text range and get a
 * `data-anchor-hit` attribute instead. An instance with no highlights does not touch the registry
 * at all. Returns a cleanup that removes this root's contribution again.
 */
export function applyWriteHighlights(
  root: HTMLElement,
  markdown: string,
  highlights: readonly HighlightRange[],
  focusedId: string | null,
): () => void {
  if (highlights.length === 0) return () => {};
  const all = pieces(root);
  const located: LocatedHighlight[] = [];

  for (const highlight of highlights) {
    const item: LocatedHighlight = {
      id: highlight.id,
      kind: highlight.kind,
      ranges: [],
      elements: [],
    };
    for (const piece of all) {
      if (piece.e <= highlight.start || piece.s >= highlight.end) continue;
      if (piece.el.hasAttribute('data-src-opaque')) {
        item.elements.push(piece.el);
        continue;
      }
      const range = rangeInPiece(piece, markdown, highlight.start, highlight.end);
      if (range) item.ranges.push(range);
    }
    located.push(item);
  }
  return paintHighlights(root, located, focusedId);
}

function inRect(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * Ids of the highlights under a pointer at `(x, y)`, shortest first: a click on a highlight's own
 * painted rectangles (not on the blank space after a line, not on the neighbour of a nested
 * highlight), or on an opaque piece (math, citation chip) that carries one. Never prevents
 * anything: link and chip clicks go through as usual.
 */
export function highlightIdsAtPoint(
  root: HTMLElement,
  x: number,
  y: number,
  target: EventTarget | null,
): string[] {
  const found: { id: string; length: number }[] = [];
  if (target instanceof Element) {
    const hit = target.closest('[data-anchor-hit]');
    if (hit && root.contains(hit)) {
      for (const id of (hit.getAttribute('data-anchor-hit') ?? '').split(' ').filter(Boolean)) {
        found.push({ id, length: 0 });
      }
    }
  }
  const entry = applied.get(root);
  if (entry) {
    for (const [id, ranges] of entry.ranges) {
      if (found.some((candidate) => candidate.id === id)) continue;
      if (ranges.some((range) => [...range.getClientRects()].some((rect) => inRect(rect, x, y)))) {
        found.push({ id, length: ranges.reduce((sum, range) => sum + range.toString().length, 0) });
      }
    }
  }
  return found.sort((a, b) => a.length - b.length).map((candidate) => candidate.id);
}
