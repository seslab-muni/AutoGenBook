import { StateEffect, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

/** An anchored range in the Source view: UTF-16 offsets, as CodeMirror counts. */
export interface AnchorHighlight {
  id: string;
  kind: string;
  start: number;
  end: number;
  /** Tracked through edits but not drawn (filtered out, or resolved and hidden). */
  hidden?: boolean;
}

/** Replaces every tracked range (the sheet resolved anchors and pushes the result). */
export const setAnchorHighlights = StateEffect.define<readonly AnchorHighlight[]>();
/** Which highlight is focused (its card is the focused one), or `null`. */
export const setFocusedAnchor = StateEffect.define<string | null>();

interface Tracked {
  id: string;
  kind: string;
  hidden: boolean;
  from: number;
  to: number;
  /** An edit swallowed the range: it stays tracked as deleted until the next `setAnchorHighlights`. */
  deleted: boolean;
}

interface HighlightState {
  ranges: readonly Tracked[];
  focused: string | null;
  decorations: DecorationSet;
}

function build(ranges: readonly Tracked[], focused: string | null): DecorationSet {
  const marks = ranges
    .filter((range) => !range.deleted && !range.hidden && range.to > range.from)
    .sort((a, b) => a.from - b.from || b.to - a.to)
    .map((range) =>
      Decoration.mark({
        class: `anchor-mark anchor-${range.kind}${range.id === focused ? ' anchor-focused' : ''}`,
        attributes: { 'data-anchor-ids': range.id },
        inclusiveStart: false,
        inclusiveEnd: false,
      }).range(range.from, range.to),
    );
  return Decoration.set(marks, true);
}

/**
 * The anchored ranges as one state field, and the single source of truth for where they sit while
 * the Source view is open: every edit maps them through CodeMirror's own change set (a start edge
 * is non-inclusive, so text typed right before a highlight stays outside it; an edge inside a
 * deletion collapses onto it), a range that collapses is flagged deleted rather than guessed at.
 * Module-level and identity-stable: it never makes the editor reconfigure.
 */
export const anchorHighlightField = StateField.define<HighlightState>({
  create: () => ({ ranges: [], focused: null, decorations: Decoration.none }),
  update(value, tr) {
    let { ranges, focused } = value;
    let rebuild = false;
    for (const effect of tr.effects) {
      if (effect.is(setAnchorHighlights)) {
        const length = tr.newDoc.length;
        ranges = effect.value.map((highlight) => {
          const from = Math.max(0, Math.min(highlight.start, length));
          const to = Math.max(0, Math.min(highlight.end, length));
          return {
            id: highlight.id,
            kind: highlight.kind,
            hidden: highlight.hidden ?? false,
            from,
            to,
            deleted: to <= from,
          };
        });
        rebuild = true;
      } else if (effect.is(setFocusedAnchor)) {
        focused = effect.value;
        rebuild = true;
      }
    }
    if (!rebuild && tr.docChanged) {
      ranges = ranges.map((range) => {
        if (range.deleted) return range;
        const from = tr.changes.mapPos(range.from, 1);
        const to = tr.changes.mapPos(range.to, -1);
        return { ...range, from, to: Math.max(to, from), deleted: to <= from };
      });
      rebuild = true;
    }
    return rebuild ? { ranges, focused, decorations: build(ranges, focused) } : value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** The tracked ranges right now (`null` = swallowed by an edit), by id. */
export function anchorRangesOf(
  state: EditorState,
): Map<string, { start: number; end: number } | null> {
  const out = new Map<string, { start: number; end: number } | null>();
  for (const range of state.field(anchorHighlightField).ranges) {
    out.set(range.id, range.deleted ? null : { start: range.from, end: range.to });
  }
  return out;
}

/** Which highlight the field currently draws as focused. */
export function anchorFocusedOf(state: EditorState): string | null {
  return state.field(anchorHighlightField).focused;
}

/** True when the field already holds exactly `highlights` (so pushing them again would be a no-op). */
export function anchorHighlightsMatch(
  state: EditorState,
  highlights: readonly AnchorHighlight[],
): boolean {
  const ranges = state.field(anchorHighlightField).ranges;
  if (ranges.length !== highlights.length) return false;
  return highlights.every((highlight, i) => {
    const range = ranges[i]!;
    return (
      range.id === highlight.id &&
      range.kind === highlight.kind &&
      range.hidden === (highlight.hidden ?? false) &&
      (range.deleted
        ? highlight.end <= highlight.start
        : range.from === highlight.start && range.to === highlight.end)
    );
  });
}

/** Anchor ids of the highlights under a DOM target inside the editor (innermost first). */
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
