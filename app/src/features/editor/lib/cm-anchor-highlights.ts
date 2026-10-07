import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

/** A highlighted range in the Source view: UTF-16 offsets, as CodeMirror counts. */
export interface AnchorHighlight {
  id: string;
  kind: string;
  start: number;
  end: number;
}

/** Replaces the whole highlight set (the sheet resolves anchors and pushes the result). */
export const setAnchorHighlights = StateEffect.define<readonly AnchorHighlight[]>();
/** Which highlight is focused (its card is the focused one), or `null`. */
export const setFocusedAnchor = StateEffect.define<string | null>();

interface HighlightState {
  highlights: readonly AnchorHighlight[];
  focused: string | null;
  decorations: DecorationSet;
}

function build(
  highlights: readonly AnchorHighlight[],
  focused: string | null,
  length: number,
): DecorationSet {
  const ranges = highlights
    .map((highlight) => ({
      ...highlight,
      start: Math.max(0, Math.min(highlight.start, length)),
      end: Math.max(0, Math.min(highlight.end, length)),
    }))
    .filter((highlight) => highlight.end > highlight.start)
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .map((highlight) =>
      Decoration.mark({
        class: `anchor-mark anchor-${highlight.kind}${highlight.id === focused ? ' anchor-focused' : ''}`,
        attributes: { 'data-anchor-ids': highlight.id },
        inclusiveStart: false,
        inclusiveEnd: false,
      }).range(highlight.start, highlight.end),
    );
  return Decoration.set(ranges, true);
}

/**
 * The highlights as a state field. Edits map the decorations, so a highlight follows its words
 * while the user types, before React has re-resolved anything; a deleted range simply vanishes.
 * Module-level and identity-stable: it never makes the editor reconfigure.
 */
export const anchorHighlightField = StateField.define<HighlightState>({
  create: () => ({ highlights: [], focused: null, decorations: Decoration.none }),
  update(value, tr) {
    let { highlights, focused } = value;
    let rebuild = false;
    for (const effect of tr.effects) {
      if (effect.is(setAnchorHighlights)) {
        highlights = effect.value;
        rebuild = true;
      } else if (effect.is(setFocusedAnchor)) {
        focused = effect.value;
        rebuild = true;
      }
    }
    if (rebuild) {
      return { highlights, focused, decorations: build(highlights, focused, tr.newDoc.length) };
    }
    if (tr.docChanged) {
      return { ...value, decorations: value.decorations.map(tr.changes) };
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

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
