import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MarkdownView } from '@/features/editor/components/markdown-view';
import { isBackwardSelection, sourceSelectionFromRange } from './dom-source-selection';
import { selectionInfo } from './selection-info';

function setup(md: string) {
  const { container } = render(<MarkdownView markdown={md} sourceMap />);
  return container;
}

function textNode(container: HTMLElement, contains: string): Text {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n as Text).data.includes(contains)) return n as Text;
  }
  throw new Error(`no text node with ${contains}`);
}

function rangeOf(a: Node, ao: number, b: Node, bo: number): Range {
  const r = document.createRange();
  r.setStart(a, ao);
  r.setEnd(b, bo);
  return r;
}

function sel(container: HTMLElement, md: string, range: Range) {
  const out = sourceSelectionFromRange(container, range, md);
  return out && { text: md.slice(out.from, out.to), ...out };
}

describe('sourceSelectionFromRange', () => {
  it('maps a selection inside one text node', () => {
    const md = 'The quick brown fox jumps.';
    const c = setup(md);
    const t = textNode(c, 'quick');
    const out = sel(c, md, rangeOf(t, 4, t, 15));
    expect(out?.text).toBe('quick brown');
  });

  it('maps a selection across formatting and paragraphs', () => {
    const md = 'Some *emphasised words* here.\n\nSecond **bold** paragraph.';
    const c = setup(md);
    const a = textNode(c, 'emphasised');
    const b = textNode(c, 'Second');
    const out = sel(c, md, rangeOf(a, 0, b, 6));
    expect(out?.text).toBe('emphasised words* here.\n\nSecond');
  });

  it('accounts for escapes in the source', () => {
    const md = 'Cost is 5 \\* 3 and more text.';
    const c = setup(md);
    const t = textNode(c, 'and more');
    const at = t.data.indexOf('and more');
    const out = sel(c, md, rangeOf(t, at, t, at + 8));
    expect(out?.text).toBe('and more');
  });

  it('snaps a selection that ends inside rendered math to the whole math node', () => {
    const md = 'Let $a+b$ be a sum of things.';
    const c = setup(md);
    const t = textNode(c, 'Let ');
    const mathText = c.querySelector('.katex-mathml annotation')!.firstChild!;
    const out = sel(c, md, rangeOf(t, 0, mathText, 2));
    expect(out?.text).toBe('Let $a+b$');
  });

  it('moves an element-level boundary to the nearest text', () => {
    const md = 'First line.\n\nSecond line.';
    const c = setup(md);
    const paragraphs = c.querySelectorAll('p');
    const out = sel(c, md, rangeOf(paragraphs[0]!, 0, paragraphs[1]!, 1));
    expect(out?.text).toBe('First line.\n\nSecond line.');
  });

  it('returns null outside the view or for an empty mapping', () => {
    const md = 'Hello world.';
    const c = setup(md);
    const outside = document.createElement('div');
    outside.textContent = 'elsewhere';
    document.body.append(outside);
    expect(
      sourceSelectionFromRange(c, rangeOf(outside.firstChild!, 0, outside.firstChild!, 4), md),
    ).toBeNull();
    outside.remove();
  });

  it('gives a caret position for a collapsed range in text', () => {
    const md = 'Hello world.';
    const c = setup(md);
    const t = textNode(c, 'Hello');
    const out = sourceSelectionFromRange(c, rangeOf(t, 6, t, 6), md);
    expect(out).toEqual({ from: 6, to: 6, head: 6 });
  });

  it('reports a backward selection', () => {
    const md = 'Hello world.';
    const c = setup(md);
    const t = textNode(c, 'Hello');
    window.getSelection()!.setBaseAndExtent(t, 8, t, 2);
    expect(isBackwardSelection(window.getSelection()!)).toBe(true);
  });
});

describe('selectionInfo', () => {
  it('converts to code points with 1-based line and column of the head', () => {
    const text = 'ab\n😀cd ef';
    const info = selectionInfo(text, 3, 8, 8);
    expect(info).toEqual({ from: 3, to: 7, line: 2, column: 5 });
  });
});
