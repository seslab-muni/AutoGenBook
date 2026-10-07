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

    it('maps a click on a highlight to its id through the caret it leaves', () => {
      const onAnchorClick = vi.fn();
      const start = MD.indexOf('some words');
      const { container } = render(
        <MarkdownView
          markdown={MD}
          anchorMarks={[{ id: 'a', kind: 'comment', start, end: start + 10 }]}
          sourceMap
          onAnchorClick={onAnchorClick}
        />,
      );
      const piece = [...container.querySelectorAll('[data-src-start]')].find((el) =>
        el.textContent?.includes('some words'),
      )!;
      const text = piece.firstChild as Text;
      const at = text.data.indexOf('some words') + 3;
      const range = document.createRange();
      range.setStart(text, at);
      range.collapse(true);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      fireEvent.click(piece);
      expect(onAnchorClick).toHaveBeenCalledWith(['a']);
      onAnchorClick.mockClear();
      range.setStart(text, 0);
      range.collapse(true);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      fireEvent.click(piece);
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
