import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import {
  anchorHighlightField,
  anchorIdsAt,
  setAnchorHighlights,
  setFocusedAnchor,
} from './cm-anchor-highlights';

function ranges(state: EditorState) {
  const out: { from: number; to: number; cls: string; id: string }[] = [];
  state.field(anchorHighlightField).decorations.between(0, state.doc.length, (from, to, value) => {
    const spec = value.spec as { class: string; attributes: Record<string, string> };
    out.push({ from, to, cls: spec.class, id: spec.attributes['data-anchor-ids']! });
  });
  return out;
}

const base = () =>
  EditorState.create({
    doc: 'The quick brown fox jumps over the lazy dog',
    extensions: [anchorHighlightField],
  });

describe('anchor highlight field', () => {
  it('draws one mark per highlight, coloured by kind', () => {
    const state = base().update({
      effects: setAnchorHighlights.of([
        { id: 'a', kind: 'comment', start: 4, end: 9 },
        { id: 'b', kind: 'suggestion', start: 10, end: 15 },
      ]),
    }).state;
    expect(ranges(state).map((r) => [r.id, r.from, r.to, r.cls])).toEqual([
      ['a', 4, 9, 'anchor-mark anchor-comment'],
      ['b', 10, 15, 'anchor-mark anchor-suggestion'],
    ]);
  });

  it('maps through edits: before shifts, inside grows, deleting removes', () => {
    let state = base().update({
      effects: setAnchorHighlights.of([{ id: 'a', kind: 'comment', start: 4, end: 9 }]),
    }).state;
    state = state.update({ changes: { from: 0, insert: 'XX' } }).state;
    expect(ranges(state)[0]).toMatchObject({ from: 6, to: 11 });
    state = state.update({ changes: { from: 8, insert: '!!' } }).state;
    expect(ranges(state)[0]).toMatchObject({ from: 6, to: 13 });
    state = state.update({ changes: { from: 4, to: 20 } }).state;
    expect(ranges(state)).toEqual([]);
  });

  it('marks the focused highlight and ignores empty or out-of-range ones', () => {
    let state = base().update({
      effects: [
        setAnchorHighlights.of([
          { id: 'a', kind: 'comment', start: 4, end: 9 },
          { id: 'e', kind: 'comment', start: 5, end: 5 },
          { id: 'far', kind: 'comment', start: 500, end: 600 },
        ]),
        setFocusedAnchor.of('a'),
      ],
    }).state;
    expect(ranges(state)).toHaveLength(1);
    expect(ranges(state)[0]!.cls).toContain('anchor-focused');
    state = state.update({ effects: setFocusedAnchor.of(null) }).state;
    expect(ranges(state)[0]!.cls).not.toContain('anchor-focused');
  });

  it('finds the anchor ids under a click target, innermost first', () => {
    const outer = document.createElement('span');
    outer.setAttribute('data-anchor-ids', 'outer');
    const inner = document.createElement('span');
    inner.setAttribute('data-anchor-ids', 'inner');
    outer.append(inner);
    inner.textContent = 'x';
    expect(anchorIdsAt(inner)).toEqual(['inner', 'outer']);
    expect(anchorIdsAt(document.createElement('div'))).toEqual([]);
    expect(anchorIdsAt(null)).toEqual([]);
  });
});
