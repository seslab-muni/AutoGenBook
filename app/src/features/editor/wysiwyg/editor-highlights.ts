import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';

import {
  mapRangeThroughChange,
  type TextChange,
  type TextRange,
} from '@/features/editor/lib/anchors';
import type { LocatedHighlight } from '@/features/editor/lib/write-highlights';

import type { SourceModel } from './source-model';

/** An anchored range being tracked through edits: UTF-16 offsets over the draft. */
export interface TrackedHighlight {
  id: string;
  kind: string;
  /** Tracked through edits but not drawn (filtered out, or resolved and hidden). */
  hidden: boolean;
  start: number;
  end: number;
  /** An edit swallowed the range: it stays tracked as deleted until the next resolved set arrives. */
  deleted: boolean;
}

export interface HighlightInput {
  id: string;
  kind: string;
  start: number;
  end: number;
  hidden?: boolean;
}

export function trackedFrom(
  highlights: readonly HighlightInput[],
  length: number,
): TrackedHighlight[] {
  return highlights.map((highlight) => {
    const start = Math.max(0, Math.min(highlight.start, length));
    const end = Math.max(0, Math.min(highlight.end, length));
    return {
      id: highlight.id,
      kind: highlight.kind,
      hidden: highlight.hidden ?? false,
      start,
      end,
      deleted: end <= start,
    };
  });
}

/** True when the tracked set is exactly `highlights` (pushing them again would change nothing). */
export function trackedMatches(
  tracked: readonly TrackedHighlight[],
  highlights: readonly HighlightInput[],
): boolean {
  if (tracked.length !== highlights.length) return false;
  return highlights.every((highlight, i) => {
    const range = tracked[i]!;
    return (
      range.id === highlight.id &&
      range.kind === highlight.kind &&
      range.hidden === (highlight.hidden ?? false) &&
      (range.deleted
        ? highlight.end <= highlight.start
        : range.start === highlight.start && range.end === highlight.end)
    );
  });
}

/** The tracked ranges after a source change: shifted like the Source view's change sets shift them. */
export function mapTracked(
  tracked: readonly TrackedHighlight[],
  change: TextChange,
): TrackedHighlight[] {
  return tracked.map((range) => {
    if (range.deleted) return range;
    const mapped = mapRangeThroughChange({ start: range.start, end: range.end }, change);
    return mapped
      ? { ...range, start: mapped.start, end: mapped.end }
      : { ...range, deleted: true };
  });
}

export function trackedPositions(
  tracked: readonly TrackedHighlight[],
): Map<string, TextRange | null> {
  return new Map(
    tracked.map((range) => [
      range.id,
      range.deleted ? null : { start: range.start, end: range.end },
    ]),
  );
}

function domRange(view: EditorView, from: number, to: number): Range | null {
  try {
    const a = view.domAtPos(from);
    const b = view.domAtPos(to);
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    return range.collapsed ? null : range;
  } catch {
    return null;
  }
}

/** The drawn highlights as DOM ranges (text) and elements (atoms), for the Custom Highlight API. */
export function locateHighlights(
  view: EditorView,
  model: SourceModel,
  tracked: readonly TrackedHighlight[],
): LocatedHighlight[] {
  const out: LocatedHighlight[] = [];
  for (const range of tracked) {
    if (range.deleted || range.hidden || range.end <= range.start) continue;
    const { text, atoms } = model.rangesForSource(range.start, range.end);
    const ranges: Range[] = [];
    for (const part of text) {
      const dom = domRange(view, part.from, part.to);
      if (dom) ranges.push(dom);
    }
    const elements: HTMLElement[] = [];
    for (const pos of atoms) {
      const dom = view.nodeDOM(pos);
      if (dom instanceof HTMLElement) elements.push(dom);
    }
    out.push({ id: range.id, kind: range.kind, ranges, elements });
  }
  return out;
}

export interface DecorationSource {
  tracked: readonly TrackedHighlight[];
  focusedId: string | null;
  model: SourceModel;
  /** Highlights are drawn with decorations only where the Custom Highlight API is missing. */
  enabled: boolean;
  /** Changing the version makes the plugin build its decorations again. */
  version: number;
}

export const decorateKey = new PluginKey('mdHighlightDecorations');

/**
 * Fallback for browsers without the CSS Custom Highlight API: the ranges are drawn as `<mark>`
 * decorations (the class names the highlight CSS styles). Built when ProseMirror asks for
 * decorations (after the source model has caught up with the new document), and again only when
 * the document or the source's `version` changes; the caller does not bump it in the middle of an
 * IME composition, so ProseMirror's own rendering of composed text is left alone.
 */
export function highlightDecorations(read: () => DecorationSource): Plugin {
  let cached: {
    doc: unknown;
    version: number;
    focusedId: string | null;
    set: DecorationSet;
  } | null = null;
  return new Plugin({
    key: decorateKey,
    props: {
      decorations(state) {
        const source = read();
        if (!source.enabled) return null;
        if (
          cached &&
          cached.doc === state.doc &&
          cached.version === source.version &&
          cached.focusedId === source.focusedId
        ) {
          return cached.set;
        }
        const decorations: Decoration[] = [];
        for (const range of source.tracked) {
          if (range.deleted || range.hidden || range.end <= range.start) continue;
          const { text, atoms } = source.model.rangesForSource(range.start, range.end);
          const className = `anchor-mark anchor-${range.kind}${range.id === source.focusedId ? ' anchor-focused' : ''}`;
          for (const part of text) {
            if (part.to > state.doc.content.size) continue;
            decorations.push(
              Decoration.inline(
                part.from,
                part.to,
                { nodeName: 'mark', class: className, 'data-anchor-ids': range.id },
                { inclusiveStart: false, inclusiveEnd: false },
              ),
            );
          }
          for (const pos of atoms) {
            const node = state.doc.nodeAt(pos);
            if (node) {
              decorations.push(
                Decoration.node(pos, pos + node.nodeSize, {
                  class: className,
                  'data-anchor-ids': range.id,
                }),
              );
            }
          }
        }
        const set = DecorationSet.create(state.doc, decorations);
        cached = { doc: state.doc, version: source.version, focusedId: source.focusedId, set };
        return set;
      },
    },
  });
}

/** Anchor ids of the `<mark>`s (or marked atoms) around a DOM target, innermost first. */
export function anchorIdsAt(target: EventTarget | null): string[] {
  if (!(target instanceof Element)) return [];
  const ids: string[] = [];
  for (let el: Element | null = target.closest('[data-anchor-ids]'); el;) {
    const id = el.getAttribute('data-anchor-ids');
    if (id) ids.push(id);
    el = el.parentElement?.closest('[data-anchor-ids]') ?? null;
  }
  return ids;
}
