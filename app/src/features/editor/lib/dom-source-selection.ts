import { alignValueToSource } from './source-map';

/** A selection in the rendered view, as UTF-16 offsets over the author's Markdown. */
export interface SourceSelection {
  from: number;
  to: number;
  /** The end the caret is at (the selection's focus). */
  head: number;
}

function num(el: Element, name: string): number {
  return Number(el.getAttribute(name));
}

/** True for a wrapper holding exactly one text node (what `rehypeAnchorSource` emits for text). */
function isTextSegment(el: Element, node: Node): boolean {
  return el.childNodes.length === 1 && el.firstChild === node;
}

/**
 * Binary search over the tagged elements (document order, flat) for the first whose start point is
 * not before `(node, offset)`, or the last whose end point is not after it.
 */
function nearestMarker(
  markers: readonly Element[],
  boundary: Range,
  edge: 'start' | 'end',
): number | null {
  let lo = 0;
  let hi = markers.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const marker = markers[mid]!;
    const point = edge === 'start' ? 0 : marker.childNodes.length;
    // comparePoint: -1 = point before the (collapsed) boundary, 0 = at it, 1 = after it.
    const where = boundary.comparePoint(marker, point);
    if (edge === 'start') {
      if (where >= 0) {
        found = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    } else if (where <= 0) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return null;
  const marker = markers[found]!;
  return num(marker, edge === 'start' ? 'data-src-start' : 'data-src-end');
}

function resolveBoundary(
  root: Element,
  markers: readonly Element[],
  markdown: string,
  node: Node,
  offset: number,
  edge: 'start' | 'end',
): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const marker = node.parentElement?.closest('[data-src-start]');
    if (marker && root.contains(marker)) {
      const s = num(marker, 'data-src-start');
      const e = num(marker, 'data-src-end');
      // Inside math, a citation chip or any other opaque output: snap to the enclosing source node.
      if (!isTextSegment(marker, node)) return edge === 'start' ? s : e;
      const value = (node as Text).data;
      if (offset <= 0) return s;
      if (offset >= value.length) return e;
      const map = alignValueToSource(value, markdown.slice(s, e));
      if (!map) return edge === 'start' ? s : e;
      return edge === 'start' ? s + map[offset]! : s + map[offset - 1]! + 1;
    }
  }
  const boundary = document.createRange();
  boundary.setStart(node, offset);
  boundary.collapse(true);
  return nearestMarker(markers, boundary, edge);
}

/** Moves the edges of `[from, to)` inwards past whitespace; `null` if nothing is left. */
export function trimRange(markdown: string, from: number, to: number): [number, number] | null {
  let a = from;
  let b = to;
  while (a < b && /\s/.test(markdown[a]!)) a += 1;
  while (b > a && /\s/.test(markdown[b - 1]!)) b -= 1;
  return a < b ? [a, b] : null;
}

/**
 * Maps a selection made in the rendered (Write) view back to a range of the Markdown source.
 * Text nodes are located through the `data-src-*` tags `rehypeAnchorSource` puts on every
 * positioned text piece, aligned character by character where escapes or entities make the text
 * differ from its source; a boundary inside rendered math, a citation chip or other opaque output
 * snaps to the enclosing source node, and one on an element is moved to the nearest tagged text.
 * Returns `null` when nothing in the selection maps to the source.
 */
export function sourceSelectionFromRange(
  root: Element,
  range: Range,
  markdown: string,
  backwards = false,
): SourceSelection | null {
  if (!root.contains(range.commonAncestorContainer)) return null;
  const markers = [...root.querySelectorAll('[data-src-start]')];
  if (markers.length === 0) return null;
  const from = resolveBoundary(
    root,
    markers,
    markdown,
    range.startContainer,
    range.startOffset,
    'start',
  );
  if (range.collapsed) {
    if (from === null || range.startContainer.nodeType !== Node.TEXT_NODE) return null;
    return { from, to: from, head: from };
  }
  const to = resolveBoundary(root, markers, markdown, range.endContainer, range.endOffset, 'end');
  if (from === null || to === null || to <= from) return null;
  const trimmed = trimRange(markdown, from, to);
  if (!trimmed) return null;
  return { from: trimmed[0], to: trimmed[1], head: backwards ? trimmed[0] : trimmed[1] };
}

/** Whether the DOM selection runs from its end back to its start. */
export function isBackwardSelection(selection: Selection): boolean {
  if (!selection.anchorNode || !selection.focusNode) return false;
  const probe = document.createRange();
  probe.setStart(selection.anchorNode, selection.anchorOffset);
  probe.setEnd(selection.focusNode, selection.focusOffset);
  return (
    probe.collapsed &&
    (selection.anchorNode !== selection.focusNode ||
      selection.anchorOffset !== selection.focusOffset)
  );
}
