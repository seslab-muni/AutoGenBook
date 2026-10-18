import { CodePointIndex } from '@/features/editor/lib/anchors';
import type { Hunk } from '@/features/editor/lib/card-payloads';

/** A run of text in a diff block: unchanged context, text the suggestion removes, or text it adds. */
export interface DiffSegment {
  type: 'context' | 'removed' | 'added';
  text: string;
}

/** One hunk with the text around it, ready to render. */
export interface DiffBlock {
  /** Index into the suggestion's `hunks` (what `hunkIndexes` refers to). */
  hunkIndex: number;
  segments: DiffSegment[];
  /** The context was cut: the block does not start / end at the edge of the text. */
  cutBefore: boolean;
  cutAfter: boolean;
  /** Characters removed and added, for a size hint. */
  removedLength: number;
  addedLength: number;
}

export interface DiffOptions {
  /** Characters of unchanged text to show on each side of a hunk. */
  context?: number;
  /** Code-point range the context may not leave (a range suggestion shows its range only). */
  range?: { start: number; end: number } | null;
}

const DEFAULT_CONTEXT = 60;

/** Display text: the API's originals may carry CR LF, which would show as stray line breaks. */
function clean(text: string): string {
  return text.replace(/\r/g, '');
}

function isLow(text: string, index: number): boolean {
  const unit = text.charCodeAt(index);
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** Start of the context before a hunk, snapped to a word boundary so a word is not shown cut in half. */
function contextStart(text: string, hunkStart: number, floor: number, context: number): number {
  let from = Math.max(floor, hunkStart - context);
  if (from > floor) {
    // Never start in the middle of a surrogate pair, and prefer to start after a space.
    if (isLow(text, from)) from += 1;
    const space = text.indexOf(' ', from);
    if (space !== -1 && space < hunkStart && space - from < context / 2) from = space + 1;
  }
  return Math.min(from, hunkStart);
}

function contextEnd(text: string, hunkEnd: number, ceiling: number, context: number): number {
  let to = Math.min(ceiling, hunkEnd + context);
  if (to < ceiling) {
    if (isLow(text, to)) to -= 1;
    const space = text.lastIndexOf(' ', to);
    if (space > hunkEnd && to - space < context / 2) to = space;
  }
  return Math.max(to, hunkEnd);
}

/**
 * Builds one block per hunk of a suggestion from the API's hunks. `hunks` hold offsets in Unicode
 * code points into `original` (`original[start:end] == removed`); JavaScript strings are UTF-16, so
 * every offset goes through {@link CodePointIndex} before the text is sliced. The context of a
 * hunk stops where the neighbouring hunk's changed text begins, so no text is shown twice as
 * context of one and as a change of the other.
 */
export function buildDiffBlocks(
  original: string,
  hunks: readonly Hunk[],
  { context = DEFAULT_CONTEXT, range = null }: DiffOptions = {},
): DiffBlock[] {
  const index = new CodePointIndex(original);
  const bounds = range
    ? { from: index.toUnit(range.start), to: index.toUnit(range.end) }
    : { from: 0, to: original.length };
  const spans = hunks.map((hunk) => {
    const start = Math.min(index.toUnit(hunk.start), original.length);
    const end = Math.min(Math.max(index.toUnit(hunk.end), start), original.length);
    return { start, end };
  });
  const order = spans.map((_, i) => i).sort((a, b) => spans[a]!.start - spans[b]!.start);
  const blocks: DiffBlock[] = [];
  for (let rank = 0; rank < order.length; rank += 1) {
    const hunkIndex = order[rank]!;
    const hunk = hunks[hunkIndex]!;
    const span = spans[hunkIndex]!;
    const previous = rank > 0 ? spans[order[rank - 1]!]!.end : bounds.from;
    const next = rank < order.length - 1 ? spans[order[rank + 1]!]!.start : bounds.to;
    const floor = Math.max(bounds.from, Math.min(previous, span.start));
    const ceiling = Math.min(bounds.to, Math.max(next, span.end));
    const from = contextStart(original, span.start, floor, context);
    const to = contextEnd(original, span.end, ceiling, context);
    const segments: DiffSegment[] = [];
    const push = (type: DiffSegment['type'], text: string) => {
      const shown = clean(text);
      if (shown.length > 0) segments.push({ type, text: shown });
    };
    push('context', original.slice(from, span.start));
    push('removed', hunk.removed);
    push('added', hunk.added);
    push('context', original.slice(span.end, to));
    blocks.push({
      hunkIndex,
      segments,
      cutBefore: from > floor,
      cutAfter: to < ceiling,
      removedLength: hunk.removed.length,
      addedLength: hunk.added.length,
    });
  }
  return blocks;
}

/**
 * Blocks for changes whose original text is not at hand (the list endpoints leave `originalMarkdown`
 * out of a finished suggestion but keep its hunks): just the removed and the added text, with no
 * context. `only` limits it to some hunks (a partial accept's applied ones); `hunkIndex` still points
 * into the full array.
 */
export function buildHunkBlocks(hunks: readonly Hunk[], only?: readonly number[]): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  hunks.forEach((hunk, hunkIndex) => {
    if (only && !only.includes(hunkIndex)) return;
    const segments: DiffSegment[] = [];
    const removed = clean(hunk.removed);
    const added = clean(hunk.added);
    if (removed) segments.push({ type: 'removed', text: removed });
    if (added) segments.push({ type: 'added', text: added });
    blocks.push({
      hunkIndex,
      segments,
      cutBefore: false,
      cutAfter: false,
      removedLength: hunk.removed.length,
      addedLength: hunk.added.length,
    });
  });
  return blocks;
}
