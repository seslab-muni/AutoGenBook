import { afterEach, describe, expect, it, vi } from 'vitest';

import { mapTracked, trackedFrom, trackedMatches, trackedPositions } from './editor-highlights';
import { lastChange, mount, posOf, press, select, type, type Harness } from './test-harness';

let harness: Harness | null = null;
afterEach(() => {
  harness?.destroy();
  harness = null;
});

const text = 'Alpha beta gamma delta\n\nSecond paragraph here\n';
const range = (needle: string, id: string, kind = 'comment') => {
  const start = text.indexOf(needle);
  return { id, kind, start, end: start + needle.length, hidden: false };
};

describe("tracking ranges through source changes (the Source view's rules)", () => {
  it('shifts a range after the change and leaves one before it', () => {
    const tracked = trackedFrom([range('gamma', 'a'), range('Alpha', 'b')], text.length);
    const mapped = mapTracked(tracked, { from: 6, to: 6, insertedLength: 3 });
    expect(trackedPositions(mapped).get('a')).toEqual({ start: 14, end: 19 });
    expect(trackedPositions(mapped).get('b')).toEqual({ start: 0, end: 5 });
  });

  it('keeps text typed right before a range outside it, and right after it outside it', () => {
    const tracked = trackedFrom([range('beta', 'a')], text.length);
    const before = mapTracked(tracked, { from: 6, to: 6, insertedLength: 2 });
    expect(trackedPositions(before).get('a')).toEqual({ start: 8, end: 12 });
    const after = mapTracked(tracked, { from: 10, to: 10, insertedLength: 2 });
    expect(trackedPositions(after).get('a')).toEqual({ start: 6, end: 10 });
  });

  it('grows a range that is typed into, and flags one whose text is deleted', () => {
    const tracked = trackedFrom([range('beta', 'a')], text.length);
    expect(
      trackedPositions(mapTracked(tracked, { from: 8, to: 8, insertedLength: 1 })).get('a'),
    ).toEqual({
      start: 6,
      end: 11,
    });
    expect(
      trackedPositions(mapTracked(tracked, { from: 5, to: 11, insertedLength: 0 })).get('a'),
    ).toBeNull();
  });

  it('knows when the resolved set is the one it already holds', () => {
    const set = [range('beta', 'a'), range('gamma', 'b', 'review')];
    const tracked = trackedFrom(set, text.length);
    expect(trackedMatches(tracked, set)).toBe(true);
    expect(trackedMatches(tracked, [range('beta', 'a')])).toBe(false);
    expect(trackedMatches(tracked, [set[0]!, { ...set[1]!, kind: 'comment' }])).toBe(false);
    expect(
      trackedMatches(trackedFrom([{ ...set[0]!, start: 3, end: 3 }], text.length), [
        { ...set[0]!, start: 4, end: 4 },
      ]),
    ).toBe(true);
  });
});

describe('highlights in the editable view', () => {
  it('draws every kind as <mark>s where the Custom Highlight API is missing (jsdom), focused ones marked', () => {
    const highlights = [range('beta', 'a'), range('paragraph', 'b', 'review')];
    harness = mount(text, { highlights, focusedId: 'b' });
    return vi.waitFor(() => {
      const a = harness!.view.dom.querySelectorAll('mark[data-anchor-ids="a"]');
      expect([...a].map((el) => el.textContent).join('')).toBe('beta');
      expect(a[0]!.className).toContain('anchor-comment');
      const b = harness!.view.dom.querySelector('mark[data-anchor-ids="b"]')!;
      expect(b.className).toContain('anchor-review');
      expect(b.classList.contains('anchor-focused')).toBe(true);
      expect(a[0]!.classList.contains('anchor-focused')).toBe(false);
    });
  });

  it('follows typing: shifts when text is typed before, grows when typed inside, reports where ranges went', () => {
    const h = (harness = mount(text, { highlights: [range('gamma', 'g')] }));
    select(h.view, posOf(h.view, 'Alpha', 5));
    type(h.view, 'XX');
    const calls = (h.props.onHighlightsMapped as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.at(-1)![0].get('g')).toEqual({ start: 13, end: 18 });
    select(h.view, posOf(h.view, 'gamma', 2));
    type(h.view, 'Q');
    expect(calls.at(-1)![0].get('g')).toEqual({ start: 13, end: 19 });
    return vi.waitFor(() => {
      expect(h.view.dom.querySelector('mark[data-anchor-ids="g"]')!.textContent).toBe('gaQmma');
    });
  });

  it('reports a range as gone when its text is deleted, and keeps the others', () => {
    const h = (harness = mount(text, { highlights: [range('beta', 'b'), range('delta', 'd')] }));
    const from = posOf(h.view, 'beta');
    select(h.view, from, from + 4);
    press(h.view, 'Backspace');
    const calls = (h.props.onHighlightsMapped as ReturnType<typeof vi.fn>).mock.calls;
    const last = calls.at(-1)![0] as Map<string, unknown>;
    expect(last.get('b')).toBeNull();
    expect(last.get('d')).toEqual({ start: 13, end: 18 });
  });

  it('takes a new resolved set at once (the owner re-resolved anchors), and a new focused card', () => {
    const h = (harness = mount(text, { highlights: [range('beta', 'a')] }));
    h.controller.setProps({ ...h.props, highlights: [range('delta', 'a')], focusedId: 'a' });
    expect(h.view.dom.querySelector('mark[data-anchor-ids="a"]')!.textContent).toBe('delta');
    expect(
      h.view.dom.querySelector('mark[data-anchor-ids="a"]')!.classList.contains('anchor-focused'),
    ).toBe(true);
  });

  it('draws a range that crosses an inline atom, and rings the atom itself', () => {
    const doc = 'Before $x^2$ after\n';
    const start = doc.indexOf('Before');
    const h = (harness = mount(doc, {
      highlights: [
        { id: 'a', kind: 'comment', start, end: doc.indexOf('after') + 5, hidden: false },
      ],
    }));
    expect(h.view.dom.querySelector('[data-md-atom-inline].anchor-mark')).not.toBeNull();
    expect(h.view.dom.querySelector('mark[data-anchor-ids="a"]')).not.toBeNull();
  });

  it('does not draw hidden ranges but keeps tracking them', () => {
    const h = (harness = mount(text, { highlights: [{ ...range('beta', 'a'), hidden: true }] }));
    expect(h.view.dom.querySelector('mark[data-anchor-ids="a"]')).toBeNull();
    select(h.view, 1);
    type(h.view, 'Z');
    const calls = (h.props.onHighlightsMapped as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.at(-1)![0].get('a')).toEqual({ start: 7, end: 11 });
  });

  it('click on a highlight reports its card', () => {
    const h = (harness = mount(text, { highlights: [range('beta', 'a')] }));
    const mark = h.view.dom.querySelector('mark[data-anchor-ids="a"]')!;
    mark.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(h.props.onHighlightClick).toHaveBeenCalledWith(['a']);
  });

  it('does not report a change for a highlight update', () => {
    const h = (harness = mount(text, { highlights: [range('beta', 'a')] }));
    h.controller.setProps({ ...h.props, highlights: [range('delta', 'a')] });
    expect(lastChange(h.props)).toBeUndefined();
  });
});

describe('text applied from outside', () => {
  it('replaces the content while a composition is going on only after it ends', async () => {
    const h = (harness = mount('one\n'));
    h.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(h.view.composing).toBe(true);
    h.controller.setProps({ ...h.props, value: 'server\n' });
    expect(h.controller.core.text).toBe('one\n');
    h.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await vi.waitFor(() => expect(h.controller.core.text).toBe('server\n'));
  });

  it('keeps the caret near where it was when new text arrives', () => {
    const h = (harness = mount('one two three\n'));
    select(h.view, posOf(h.view, 'two', 1));
    h.controller.setProps({ ...h.props, value: 'ONE TWO THREE\n' });
    expect(h.controller.sourceSelection()).toEqual({ from: 5, to: 5 });
  });
});
