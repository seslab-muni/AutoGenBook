import { describe, expect, it } from 'vitest';

import { parseOutlineText } from './parse-outline-text';

describe('parseOutlineText', () => {
  it('returns an empty array for an empty string', () => {
    expect(parseOutlineText('', 6)).toEqual([]);
  });

  it('returns an empty array for whitespace-only input', () => {
    expect(parseOutlineText('   \n\t\n   \n', 6)).toEqual([]);
  });

  it('returns an empty array for non-string input without throwing', () => {
    expect(parseOutlineText(null as unknown as string, 6)).toEqual([]);
    expect(parseOutlineText(undefined as unknown as string, 6)).toEqual([]);
    expect(parseOutlineText(42 as unknown as string, 6)).toEqual([]);
  });

  it('treats plain lines as flat, top-level chapters', () => {
    expect(parseOutlineText('Intro\nMethods\nResults', 6)).toEqual([
      { title: 'Intro', children: [] },
      { title: 'Methods', children: [] },
      { title: 'Results', children: [] },
    ]);
  });

  it('strips common bullet markers from plain lines', () => {
    expect(parseOutlineText('- Intro\n* Methods\n• Results\n+ Discussion', 6)).toEqual([
      { title: 'Intro', children: [] },
      { title: 'Methods', children: [] },
      { title: 'Results', children: [] },
      { title: 'Discussion', children: [] },
    ]);
  });

  it('nests markdown headings by level', () => {
    const result = parseOutlineText('# Chapter 1\n## Section 1.1\n### Sub 1.1.1\n# Chapter 2', 6);
    expect(result).toEqual([
      {
        title: 'Chapter 1',
        children: [
          {
            title: 'Section 1.1',
            children: [{ title: 'Sub 1.1.1', children: [] }],
          },
        ],
      },
      { title: 'Chapter 2', children: [] },
    ]);
  });

  it('strips trailing closing hashes from markdown headings', () => {
    expect(parseOutlineText('## Section ##', 6)).toEqual([{ title: 'Section', children: [] }]);
  });

  it('falls back to literal text when a "#"-led line has no separate title', () => {
    expect(parseOutlineText('#\n##   \nReal chapter', 6)).toEqual([
      { title: '#', children: [] },
      { title: '##', children: [] },
      { title: 'Real chapter', children: [] },
    ]);
  });

  it('nests dotted numbered headings by segment count', () => {
    const result = parseOutlineText('1. Chapter 1\n1.1 Section\n1.1.1 Subsection\n2. Chapter 2', 6);
    expect(result).toEqual([
      {
        title: 'Chapter 1',
        children: [
          {
            title: 'Section',
            children: [{ title: 'Subsection', children: [] }],
          },
        ],
      },
      { title: 'Chapter 2', children: [] },
    ]);
  });

  it('accepts parenthesized numbering and trailing dots', () => {
    expect(parseOutlineText('1) Chapter 1\n2.3.1) Nested', 6)).toEqual([
      { title: 'Chapter 1', children: [{ title: 'Nested', children: [] }] },
    ]);
  });

  it('requires trailing punctuation for single-segment numbers to avoid false positives', () => {
    expect(parseOutlineText('3 blind mice\n42 is the answer', 6)).toEqual([
      { title: '3 blind mice', children: [] },
      { title: '42 is the answer', children: [] },
    ]);
  });

  it('falls back to literal text when a numbered-looking line has no separate title', () => {
    expect(parseOutlineText('1.\n2)\nReal chapter', 6)).toEqual([
      { title: '1.', children: [] },
      { title: '2)', children: [] },
      { title: 'Real chapter', children: [] },
    ]);
  });

  it('handles mixed line styles in a single paste', () => {
    const result = parseOutlineText('# Chapter 1\n1.1 Section under it\nPlain top-level line', 6);
    expect(result).toEqual([
      {
        title: 'Chapter 1',
        children: [{ title: 'Section under it', children: [] }],
      },
      { title: 'Plain top-level line', children: [] },
    ]);
  });

  it('clamps nesting depth to maxDepth', () => {
    const result = parseOutlineText('# A\n## B\n### C\n#### D\n##### E', 3);
    expect(result).toEqual([
      {
        title: 'A',
        children: [
          {
            title: 'B',
            children: [
              { title: 'C', children: [] },
              { title: 'D', children: [] },
              { title: 'E', children: [] },
            ],
          },
        ],
      },
    ]);
  });

  it('treats maxDepth of 0 or negative as a single flat level', () => {
    expect(parseOutlineText('# A\n## B', 0)).toEqual([
      { title: 'A', children: [] },
      { title: 'B', children: [] },
    ]);
    expect(parseOutlineText('# A\n## B', -3)).toEqual([
      { title: 'A', children: [] },
      { title: 'B', children: [] },
    ]);
  });

  it('starts a new root when the first heading is deeply nested with no ancestor', () => {
    expect(parseOutlineText('### Orphan sub-section\n# Top', 6)).toEqual([
      { title: 'Orphan sub-section', children: [] },
      { title: 'Top', children: [] },
    ]);
  });

  it('does not require monotonically increasing numbering to build structure', () => {
    const result = parseOutlineText('2. Chapter 2\n2.1 Section\n1. Chapter 1', 6);
    expect(result).toEqual([
      { title: 'Chapter 2', children: [{ title: 'Section', children: [] }] },
      { title: 'Chapter 1', children: [] },
    ]);
  });

  it('handles CRLF and CR line endings', () => {
    expect(parseOutlineText('Intro\r\nMethods\rResults', 6)).toEqual([
      { title: 'Intro', children: [] },
      { title: 'Methods', children: [] },
      { title: 'Results', children: [] },
    ]);
  });

  it('ignores blank lines between entries', () => {
    expect(parseOutlineText('Intro\n\n\nMethods\n   \nResults', 6)).toEqual([
      { title: 'Intro', children: [] },
      { title: 'Methods', children: [] },
      { title: 'Results', children: [] },
    ]);
  });

  it('handles a large number of lines without throwing', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `Chapter ${i}`);
    const result = parseOutlineText(lines.join('\n'), 6);
    expect(result).toHaveLength(5000);
  });
});
