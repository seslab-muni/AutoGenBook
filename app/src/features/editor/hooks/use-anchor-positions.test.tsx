import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeAnchor } from '@/features/editor/lib/anchors';
import { useAnchorPositions, type AnchorItem } from './use-anchor-positions';

const TEXT = 'Alpha beta gamma. The quoted words live in this sentence. Omega delta.';
const START = TEXT.indexOf('The quoted words');
const END = START + 'The quoted words'.length;

type Props = { text: string; items: AnchorItem[]; resetKey?: number };

function setup(initial: Props) {
  return renderHook(
    ({ text, items, resetKey = 0 }: Props) =>
      useAnchorPositions(items, text, { resetKey, retryMs: 5 }),
    { initialProps: initial },
  );
}

const anchor = makeAnchor(TEXT, START, END);
const items = (): AnchorItem[] => [
  { id: 'c1', anchor },
  { id: 'section', anchor: null },
];

describe('useAnchorPositions', () => {
  it('resolves anchors on load and leaves section-level cards unplaced', () => {
    const { result } = setup({ text: TEXT, items: items() });
    expect(result.current.positions.get('c1')).toEqual({ start: START, end: END });
    expect(result.current.positions.get('section')).toBeNull();
    expect(result.current.pending.size).toBe(0);
  });

  it('un-orphans an anchor when the text comes back (undo), after the search is debounced', async () => {
    const list = items();
    const { result, rerender } = setup({ text: TEXT, items: list });
    const without = TEXT.replace('The quoted words', '');
    act(() => result.current.reportMapped(new Map([['c1', null]])));
    rerender({ text: without, items: list });
    expect(result.current.positions.get('c1')).toBeNull();
    expect(result.current.pending.has('c1')).toBe(true);
    await waitFor(() => expect(result.current.pending.size).toBe(0));
    // Still orphaned (the quote is gone), and no longer "pending".
    expect(result.current.positions.get('c1')).toBeNull();
    // Undo: the text returns, the editor cannot resurrect a deleted range, the retry does.
    rerender({ text: TEXT, items: list });
    await waitFor(() =>
      expect(result.current.positions.get('c1')).toEqual({ start: START, end: END }),
    );
  });

  it('cm mode: takes positions from the editor and does not diff the text itself', () => {
    const list = items();
    const { result, rerender } = setup({ text: TEXT, items: list });
    rerender({ text: 'NEW ' + TEXT, items: list });
    // Nothing reported yet: untouched.
    expect(result.current.positions.get('c1')).toEqual({ start: START, end: END });
    act(() => result.current.reportMapped(new Map([['c1', { start: START + 4, end: END + 4 }]])));
    expect(result.current.positions.get('c1')).toEqual({ start: START + 4, end: END + 4 });
  });

  it('a refetch that leaves an anchor untouched keeps its local position, a changed one is re-resolved', () => {
    const list = items();
    const { result, rerender } = setup({ text: TEXT, items: list });
    act(() => result.current.reportMapped(new Map([['c1', { start: START + 4, end: END + 4 }]])));
    const edited = 'NEW ' + TEXT;
    // Same anchor object in a new list (what structural sharing gives): local position wins.
    rerender({ text: edited, items: list.map((item) => ({ ...item })) });
    expect(result.current.positions.get('c1')).toEqual({ start: START + 4, end: END + 4 });
    // The server re-anchored: a new anchor object is resolved against the live draft.
    const reanchored = makeAnchor(edited, START + 4, END + 4);
    rerender({
      text: edited,
      items: [
        { id: 'c1', anchor: { ...reanchored } },
        { id: 'section', anchor: null },
      ],
    });
    expect(result.current.positions.get('c1')).toEqual({ start: START + 4, end: END + 4 });
  });

  it('stays orphaned (not pending) when the save re-anchors it: the refetch brings a new orphan anchor object', async () => {
    const list = items();
    const { result, rerender } = setup({ text: TEXT, items: list });
    const without = TEXT.replace('The quoted words', '');
    act(() => result.current.reportMapped(new Map([['c1', null]])));
    rerender({ text: without, items: list });
    await waitFor(() => expect(result.current.pending.size).toBe(0));
    expect(result.current.positions.get('c1')).toBeNull();
    // The autosave landed and the server re-anchored: same quote, start/end null, a new object.
    const refetched: AnchorItem[] = [
      { id: 'c1', anchor: { ...anchor, start: null, end: null } },
      { id: 'section', anchor: null },
    ];
    rerender({ text: without, items: refetched });
    expect(result.current.pending.size).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(result.current.pending.size).toBe(0);
    expect(result.current.positions.get('c1')).toBeNull();
  });

  it("keeps the editor's position when the server re-anchors a row while the user types inside it", () => {
    const list = items();
    const { result, rerender } = setup({ text: TEXT, items: list });
    // Typing inside the range: the editor grew it by 3.
    act(() => result.current.reportMapped(new Map([['c1', { start: START, end: END + 3 }]])));
    const edited = TEXT.replace('quoted', 'quoteXXXd');
    const stale = { ...makeAnchor(TEXT, START, END) };
    rerender({
      text: edited,
      items: [
        { id: 'c1', anchor: stale },
        { id: 'section', anchor: null },
      ],
    });
    expect(result.current.positions.get('c1')).toEqual({ start: START, end: END + 3 });
  });

  it('resetKey re-resolves every anchor against the replaced text', () => {
    const list = items();
    const { result, rerender } = setup({ text: TEXT, items: list });
    const replaced = 'Completely new intro. ' + TEXT;
    rerender({ text: replaced, items: list, resetKey: 1 });
    expect(result.current.positions.get('c1')).toEqual({
      start: START + 22,
      end: END + 22,
    });
  });

  it("retries an orphaned anchor with what it looked like last, not the server's stale copy (delete, save, undo)", async () => {
    const text =
      'Alpha beta gamma delta. The theorem statement holds for every input here. Alpha again.';
    const from = text.indexOf('theorem statement');
    const server = makeAnchor(text, from, from + 17);
    const list: AnchorItem[] = [{ id: 'c1', anchor: server }];
    const { result, rerender } = setup({ text, items: list });
    // The user rewrites the words around the quote (inside its stored context) and the editor keeps tracking it.
    const edited = text.replace('Alpha', 'Omega-long');
    act(() =>
      result.current.reportMapped(
        new Map([
          ['c1', { start: edited.indexOf('theorem'), end: edited.indexOf('theorem') + 17 }],
        ]),
      ),
    );
    rerender({ text: edited, items: list });
    await new Promise((resolve) => setTimeout(resolve, 40)); // the snapshot is debounced
    // Deleting the quote: saved, so the server orphans it but keeps its (now stale) quote and context.
    const gone = edited.replace('theorem statement', '');
    act(() => result.current.reportMapped(new Map([['c1', null]])));
    const orphanedByServer: AnchorItem[] = [
      { id: 'c1', anchor: { ...server, start: null, end: null } },
    ];
    rerender({ text: gone, items: orphanedByServer });
    await waitFor(() => expect(result.current.pending.size).toBe(0));
    // Undo: the words are back, with the *new* context the server's copy does not match.
    rerender({ text: edited, items: orphanedByServer });
    await waitFor(() =>
      expect(result.current.positions.get('c1')).toEqual({
        start: edited.indexOf('theorem'),
        end: edited.indexOf('theorem') + 17,
      }),
    );
  });
});
