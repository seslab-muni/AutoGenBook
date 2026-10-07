import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeAnchor } from '@/features/editor/lib/anchors';
import { useAnchorPositions, type AnchorItem } from './use-anchor-positions';

const TEXT = 'Alpha beta gamma. The quoted words live in this sentence. Omega delta.';

function setup(initial = TEXT) {
  const from = initial.indexOf('The quoted words');
  const items: AnchorItem[] = [
    { id: 'c1', anchor: makeAnchor(initial, from, from + 'The quoted words'.length) },
    { id: 'section', anchor: null },
  ];
  return renderHook(({ text, list }) => useAnchorPositions(list, text), {
    initialProps: { text: initial, list: items },
  });
}

describe('useAnchorPositions', () => {
  it('resolves anchors on load and leaves section-level cards unplaced', () => {
    const { result } = setup();
    expect(result.current.get('c1')).toEqual({ start: 18, end: 34 });
    expect(result.current.get('section')).toBeNull();
  });

  it('shifts anchors for edits before them and grows them for edits inside', () => {
    const { result, rerender } = setup();
    // Keep the same `items` identity across edits: only the text changes.
    const list = [{ id: 'c1', anchor: makeAnchor(TEXT, 18, 34) }];
    rerender({ text: TEXT, list });
    rerender({ text: 'NEW ' + TEXT, list });
    expect(result.current.get('c1')).toEqual({ start: 22, end: 38 });
    rerender({ text: 'NEW ' + TEXT.replace('quoted', 'quoted, edited,'), list });
    expect(result.current.get('c1')).toEqual({ start: 22, end: 47 });
  });

  it('orphans an anchor whose words were deleted, and re-finds it on the next load', () => {
    const items: AnchorItem[] = [{ id: 'c1', anchor: makeAnchor(TEXT, 18, 34) }];
    const hook = renderHook(({ text, list }) => useAnchorPositions(list, text), {
      initialProps: { text: TEXT, list: items },
    });
    const without = TEXT.replace('The quoted words', '');
    hook.rerender({ text: without, list: items });
    expect(hook.result.current.get('c1')).toBeNull();
    // Undo, then a fresh load of the comments resolves from the quote again.
    hook.rerender({ text: TEXT, list: items });
    expect(hook.result.current.get('c1')).toBeNull();
    const reloaded: AnchorItem[] = items.map((item) => ({ ...item }));
    act(() => hook.rerender({ text: TEXT, list: reloaded }));
    expect(hook.result.current.get('c1')).toEqual({ start: 18, end: 34 });
  });
});
