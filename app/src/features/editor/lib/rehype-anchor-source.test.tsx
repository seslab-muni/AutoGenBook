import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MarkdownView } from '@/features/editor/components/markdown-view';
import { CodePointIndex } from './anchors';
import type { AnchorMark } from './rehype-anchor-source';

/** The marks of a rendered view as `id: text` pieces, in document order. */
function marked(container: HTMLElement): string[] {
  return [...container.querySelectorAll('mark[data-anchor-ids]')].map(
    (el) => `${el.getAttribute('data-anchor-ids')}: ${el.textContent}`,
  );
}

function markFor(markdown: string, id: string, quote: string, kind = 'comment'): AnchorMark {
  const start = markdown.indexOf(quote);
  if (start < 0) throw new Error(`quote not found: ${quote}`);
  return { id, kind, start, end: start + quote.length };
}

function renderMarked(markdown: string, marks: AnchorMark[]) {
  return render(<MarkdownView markdown={markdown} anchorMarks={marks} sourceMap />).container;
}

describe('rehypeAnchorSource', () => {
  it('wraps a range inside one paragraph and leaves the rest of the text', () => {
    const md = 'The quick brown fox jumps over the lazy dog.';
    const container = renderMarked(md, [markFor(md, 'a', 'brown fox')]);
    expect(marked(container)).toEqual(['a: brown fox']);
    expect(container.querySelector('p')?.textContent).toBe(md);
  });

  it('wraps a range that crosses inline elements, one piece per text node', () => {
    const md = 'Start of *an emphasised* phrase and **bold text** end.';
    const container = renderMarked(md, [markFor(md, 'x', 'of *an emphasised* phrase and **bold')]);
    expect(marked(container)).toEqual(['x: of ', 'x: an emphasised', 'x:  phrase and ', 'x: bold']);
  });

  it('wraps a range across two paragraphs', () => {
    const md = 'First paragraph ends here.\n\nSecond paragraph starts here.';
    const container = renderMarked(md, [markFor(md, 'p', 'ends here.\n\nSecond paragraph')]);
    expect(marked(container)).toEqual(['p: ends here.', 'p: Second paragraph']);
  });

  it('keeps ranges after astral characters exact (offsets are UTF-16)', () => {
    const md = 'Emoji 😀 and 𝔖 symbols, then the target words.';
    const container = renderMarked(md, [markFor(md, 'e', 'target words')]);
    expect(marked(container)).toEqual(['e: target words']);
    // The code-point offset the API would store converts to the same UTF-16 range.
    const idx = new CodePointIndex(md);
    expect(idx.toUnit(idx.toCp(md.indexOf('target')))).toBe(md.indexOf('target'));
  });

  it('highlights text with escapes by aligning the value to its source', () => {
    const md = 'Cost is 5 \\* 3 and a *b* c.';
    const container = renderMarked(md, [markFor(md, 'esc', '3 and')]);
    expect(marked(container)).toEqual(['esc: 3 and']);
  });

  it('marks the whole inline-math element a range touches, never half of it', () => {
    const md = 'Let $x^2 + y^2$ be the norm, so that $x$ is small.';
    const container = renderMarked(md, [markFor(md, 'm', 'x^2 + y^2$ be the')]);
    const math = container.querySelector('.anchor-math[data-anchor-ids="m"]');
    expect(math?.querySelector('.katex')).not.toBeNull();
    expect(container.querySelectorAll('.anchor-math[data-anchor-ids]')).toHaveLength(1);
    expect(marked(container).some((entry) => entry.endsWith(' be the'))).toBe(true);
  });

  it('marks display math as a whole and keeps later ranges exact', () => {
    const md = 'Intro.\n\n$$\nE = mc^2\n$$\n\nThen a conclusion follows.';
    const container = renderMarked(md, [
      markFor(md, 'd', 'mc^2'),
      markFor(md, 'z', 'a conclusion'),
    ]);
    expect(
      container.querySelector('.anchor-math[data-anchor-ids="d"] .katex-display'),
    ).not.toBeNull();
    expect(marked(container)).toEqual(['z: a conclusion']);
  });

  it('highlights text next to a citation chip and tags the chip', () => {
    const md = 'As shown in [@castro1999] the protocol is safe under asynchrony.';
    const container = renderMarked(md, [markFor(md, 'c', 'the protocol is safe')]);
    expect(marked(container)).toEqual(['c: the protocol is safe']);
    expect(container.querySelector('[data-testid="citation-chip-castro1999"]')).not.toBeNull();
  });

  it('keeps ranges right after a $$ line is rewritten onto three lines', () => {
    const md = 'Before the equation.\n$$E = mc^2$$\nAfter the equation, the quoted tail.';
    const container = renderMarked(md, [markFor(md, 'tail', 'the quoted tail')]);
    expect(marked(container)).toEqual(['tail: the quoted tail']);
  });

  it('handles overlapping ranges by listing both ids on the shared piece', () => {
    const md = 'one two three four five';
    const container = renderMarked(md, [
      markFor(md, 'a', 'one two three'),
      markFor(md, 'b', 'two three four'),
    ]);
    expect(marked(container)).toEqual(['a: one ', 'a b: two three', 'b:  four']);
  });

  it('annotates source offsets on text pieces when sourceMap is on', () => {
    const md = 'Plain *emph* text.';
    const container = renderMarked(md, []);
    const spans = [...container.querySelectorAll('[data-src-start]')].map(
      (el) =>
        `${el.getAttribute('data-src-start')}-${el.getAttribute('data-src-end')}:${el.textContent}`,
    );
    expect(spans).toEqual(['0-6:Plain ', '7-11:emph', '12-18: text.']);
  });

  it('is a no-op without marks or sourceMap', () => {
    const { container } = render(<MarkdownView markdown="Nothing to see." />);
    expect(container.querySelector('[data-src-start]')).toBeNull();
    expect(container.querySelector('mark')).toBeNull();
  });
});
