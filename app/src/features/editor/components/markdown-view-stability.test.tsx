import { act, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RagCitation } from '@/features/editor/lib/rag-citation';
import { MarkdownView } from './markdown-view';

const MD =
  'The first paragraph has some words in it, see [@castro1999] for more.\n\nSecond paragraph, with more words to read.';
const CITATIONS: RagCitation[] = [
  { id: 'castro1999', sourceDoc: 'c.pdf', relevanceScore: 1, authorYear: 'Castro 1999' },
];

class FakeHighlight {
  priority = 0;
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

function stubCustomHighlights() {
  const registry = new Map<string, FakeHighlight>();
  vi.stubGlobal('Highlight', FakeHighlight);
  Object.defineProperty(CSS, 'highlights', { value: registry, configurable: true });
  return registry;
}

afterEach(() => {
  vi.unstubAllGlobals();
  // @ts-expect-error test cleanup of the stubbed registry
  delete CSS.highlights;
});

function Harness({ custom }: { custom: boolean }) {
  void custom;
  const [tick, setTick] = useState(0);
  const [focused, setFocused] = useState<string | null>(null);
  const start = MD.indexOf('some words');
  return (
    <div>
      <button type="button" onClick={() => setTick((t) => t + 1)}>
        rerender
      </button>
      <button type="button" onClick={() => setFocused('a')}>
        focus
      </button>
      <MarkdownView
        markdown={MD}
        // A new array and a new handler on every parent render: the usual way a view gets remounted.
        citations={CITATIONS.map((c) => ({ ...c }))}
        onCitationClick={() => void tick}
        anchorMarks={[{ id: 'a', kind: 'comment', start, end: start + 10 }]}
        focusedAnchorId={focused}
        sourceMap
        onAnchorClick={() => {}}
      />
    </div>
  );
}

describe('a second MarkdownView', () => {
  it("neither wipes nor paints over the first one's highlights, mounted, updated or unmounted", () => {
    const registry = stubCustomHighlights();
    const start = MD.indexOf('some words');
    const first = render(
      <MarkdownView
        markdown={MD}
        anchorMarks={[{ id: 'a', kind: 'comment', start, end: start + 10 }]}
        sourceMap
      />,
    );
    expect(registry.get('anchor-comment')?.ranges.map((r) => r.toString())).toEqual(['some words']);
    // The export preview / a reviewer's notes: no highlights of its own.
    const second = render(<MarkdownView markdown="Other text." />);
    expect(registry.get('anchor-comment')?.ranges.map((r) => r.toString())).toEqual(['some words']);
    second.rerender(<MarkdownView markdown="Other text, changed." />);
    second.unmount();
    expect(registry.get('anchor-comment')?.ranges.map((r) => r.toString())).toEqual(['some words']);
    // One with highlights of its own adds to the union and leaves it again on unmount.
    const third = render(
      <MarkdownView
        markdown="Third document here."
        anchorMarks={[{ id: 'b', kind: 'comment', start: 0, end: 5 }]}
        sourceMap
      />,
    );
    expect(
      registry
        .get('anchor-comment')
        ?.ranges.map((r) => r.toString())
        .sort(),
    ).toEqual(['Third', 'some words']);
    third.unmount();
    expect(registry.get('anchor-comment')?.ranges.map((r) => r.toString())).toEqual(['some words']);
    first.unmount();
    expect(registry.size).toBe(0);
  });
});

describe('MarkdownView DOM stability', () => {
  describe('with the CSS Custom Highlight API', () => {
    beforeEach(() => {
      stubCustomHighlights();
    });

    it("keeps its text nodes (and so the reader's selection) across parent re-renders, new citations and focus changes", () => {
      const { container, getByText } = render(<Harness custom />);
      const piece = container.querySelector('[data-src-start]')!;
      const textNode = piece.firstChild!;
      const range = document.createRange();
      range.setStart(textNode, 2);
      range.setEnd(textNode, 9);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);

      act(() => getByText('rerender').click());
      act(() => getByText('focus').click());
      act(() => getByText('rerender').click());

      expect(textNode.isConnected).toBe(true);
      expect(container.querySelector('[data-src-start]')!.firstChild).toBe(textNode);
      expect(selection.toString()).toBe(range.toString());
      expect(selection.rangeCount).toBe(1);
    });

    it('paints the ranges as custom highlights without adding any element', () => {
      const registry = (CSS as unknown as { highlights: Map<string, FakeHighlight> }).highlights;
      const { container } = render(<Harness custom />);
      expect(container.querySelector('mark')).toBeNull();
      const highlight = registry.get('anchor-comment')!;
      expect(highlight.ranges.map((r) => r.toString())).toEqual(['some words']);
    });

    it('draws the focused highlight with a higher priority and clears everything on unmount', () => {
      const registry = (CSS as unknown as { highlights: Map<string, FakeHighlight> }).highlights;
      const { getByText, unmount } = render(<Harness custom />);
      expect(registry.has('anchor-focused')).toBe(false);
      act(() => getByText('focus').click());
      expect(registry.get('anchor-focused')?.priority).toBeGreaterThan(0);
      unmount();
      expect(registry.size).toBe(0);
    });

    it('hit-tests clicks against the painted rectangles: inside, outside, and nested (shortest wins)', () => {
      const onAnchorClick = vi.fn();
      const outerStart = MD.indexOf('has some words in it');
      const innerStart = MD.indexOf('some words');
      const { container } = render(
        <MarkdownView
          markdown={MD}
          anchorMarks={[
            { id: 'outer', kind: 'comment', start: outerStart, end: outerStart + 20 },
            { id: 'inner', kind: 'review', start: innerStart, end: innerStart + 10 },
          ]}
          sourceMap
          onAnchorClick={onAnchorClick}
        />,
      );
      // jsdom has no layout: give each range one rectangle, 10px per character from x=0.
      vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
        const width = this.toString().length * 10;
        const left = this.toString() === 'some words' ? 40 : 0;
        const rect = { left, right: left + width, top: 0, bottom: 20, width, height: 20 };
        return [rect] as unknown as DOMRectList;
      });
      const piece = container.querySelector('[data-src-start]')!;
      fireEvent.click(piece, { clientX: 60, clientY: 10 });
      expect(onAnchorClick).toHaveBeenLastCalledWith(['inner', 'outer']);
      onAnchorClick.mockClear();
      fireEvent.click(piece, { clientX: 5, clientY: 10 });
      expect(onAnchorClick).toHaveBeenLastCalledWith(['outer']);
      onAnchorClick.mockClear();
      // Far to the right of the line, or below it: nothing.
      fireEvent.click(piece, { clientX: 400, clientY: 10 });
      fireEvent.click(piece, { clientX: 60, clientY: 80 });
      expect(onAnchorClick).not.toHaveBeenCalled();
    });

    it('marks opaque pieces (math, citation chips) with an attribute instead', () => {
      const md = 'Let $x^2$ be given.';
      const start = md.indexOf('$x^2$');
      const { container } = render(
        <MarkdownView
          markdown={md}
          anchorMarks={[{ id: 'm', kind: 'comment', start, end: start + 5 }]}
          sourceMap
        />,
      );
      expect(
        container.querySelector('[data-anchor-hit="m"]')?.querySelector('.katex'),
      ).not.toBeNull();
    });
  });

  it('without it, an unrelated parent re-render still keeps the text nodes', () => {
    const { container, getByText } = render(<Harness custom={false} />);
    const textNode = container.querySelector('[data-src-start]')!.firstChild!;
    act(() => getByText('rerender').click());
    expect(textNode.isConnected).toBe(true);
  });
});
