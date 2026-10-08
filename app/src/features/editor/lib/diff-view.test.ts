import { describe, expect, it } from 'vitest';

import { buildDiffBlocks, buildHunkBlocks } from './diff-view';

const text = (block: { segments: { type: string; text: string }[] }, type: string) =>
  block.segments
    .filter((segment) => segment.type === type)
    .map((segment) => segment.text)
    .join('');

describe('buildDiffBlocks', () => {
  it('shows each hunk with a little unchanged text on both sides', () => {
    const original = 'The policy improvement theorem guarantees monotone progress for every state.';
    const start = original.indexOf('guarantees');
    const blocks = buildDiffBlocks(
      original,
      [{ start, end: start + 'guarantees'.length, removed: 'guarantees', added: 'ensures' }],
      { context: 20 },
    );
    expect(blocks).toHaveLength(1);
    const [block] = blocks;
    expect(block!.hunkIndex).toBe(0);
    expect(text(block!, 'removed')).toBe('guarantees');
    expect(text(block!, 'added')).toBe('ensures');
    expect(block!.segments[0]).toEqual({
      type: 'context',
      text: expect.stringMatching(/theorem $/),
    });
    expect(block!.cutBefore).toBe(true);
    expect(block!.cutAfter).toBe(true);
  });

  it('renders a pure insertion and a pure deletion', () => {
    const original = 'One. Two. Three.';
    const blocks = buildDiffBlocks(original, [
      { start: 4, end: 4, removed: '', added: ' (inserted)' },
      { start: 10, end: 16, removed: ' Three.', added: '' },
    ]);
    expect(text(blocks[0]!, 'added')).toBe(' (inserted)');
    expect(text(blocks[0]!, 'removed')).toBe('');
    expect(text(blocks[1]!, 'removed')).toBe(' Three.');
    expect(text(blocks[1]!, 'added')).toBe('');
  });

  it('converts code-point offsets to string offsets (astral characters before a hunk)', () => {
    // Each 𝒫 is one code point but two UTF-16 units: the hunk's `start` counts code points.
    const original = '𝒫𝒫𝒫 then the claim holds trivially.';
    const startCp = Array.from('𝒫𝒫𝒫 then the claim ').length;
    const blocks = buildDiffBlocks(
      original,
      [{ start: startCp, end: startCp + 5, removed: 'holds', added: 'follows' }],
      { context: 8 },
    );
    expect(text(blocks[0]!, 'removed')).toBe('holds');
    const before = blocks[0]!.segments[0]!;
    expect(before.type).toBe('context');
    // No half characters: every surrogate in the context is part of a pair.
    expect(before.text).not.toMatch(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
    );
    expect(before.text.endsWith('claim ')).toBe(true);
  });

  it('never starts or ends the context inside a surrogate pair', () => {
    const original = `${'𝒫'.repeat(30)}X${'𝒫'.repeat(30)}`;
    const startCp = 30;
    for (const context of [1, 2, 3, 5, 7]) {
      const [block] = buildDiffBlocks(
        original,
        [{ start: startCp, end: startCp + 1, removed: 'X', added: 'Y' }],
        { context },
      );
      for (const segment of block!.segments) {
        expect(segment.text).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/);
      }
    }
  });

  it('drops carriage returns of a CRLF original from the shown text', () => {
    const original = 'Line one.\r\nLine two is here.\r\nLine three.';
    const cp = original.indexOf('two');
    const [block] = buildDiffBlocks(original, [
      { start: cp, end: cp + 3, removed: 'two', added: '2' },
    ]);
    const shown = block!.segments.map((segment) => segment.text).join('');
    expect(shown).not.toContain('\r');
    expect(shown).toContain('Line one.\nLine ');
  });

  it("stops one hunk's context where the next hunk begins, and orders blocks by position", () => {
    const original = 'alpha beta gamma delta epsilon zeta';
    const blocks = buildDiffBlocks(
      original,
      [
        { start: 17, end: 22, removed: 'delta', added: 'D' },
        { start: 6, end: 10, removed: 'beta', added: 'B' },
      ],
      { context: 100 },
    );
    // Sorted by position, but `hunkIndex` still points at the API's array.
    expect(blocks.map((block) => block.hunkIndex)).toEqual([1, 0]);
    const first = blocks[0]!;
    expect(text(first, 'context')).toBe('alpha  gamma ');
    expect(text(first, 'context')).not.toContain('delta');
    expect(text(blocks[1]!, 'context')).not.toContain('beta');
  });

  it("keeps a range suggestion's context inside its range", () => {
    const original = 'Before the range. The selected sentence is short. After the range.';
    const from = original.indexOf('The selected');
    const to = original.indexOf(' After');
    const cp = original.indexOf('short');
    const [block] = buildDiffBlocks(
      original,
      [{ start: cp, end: cp + 5, removed: 'short', added: 'a bit longer' }],
      { range: { start: from, end: to }, context: 200 },
    );
    const shown = block!.segments.map((segment) => segment.text).join('');
    // The range's own text only: removed and added text sit side by side.
    expect(shown).toBe('The selected sentence is shorta bit longer.');
    expect(shown).not.toContain('Before');
    expect(shown).not.toContain('After');
    expect(block!.cutBefore).toBe(false);
    expect(block!.cutAfter).toBe(false);
  });

  it('tolerates hunks that run past the text', () => {
    const blocks = buildDiffBlocks('short', [{ start: 3, end: 99, removed: 'rt', added: 'x' }]);
    expect(blocks).toHaveLength(1);
  });

  describe('buildHunkBlocks (a finished suggestion whose original text the list left out)', () => {
    const hunks = [
      { start: 0, end: 3, removed: 'old', added: 'new' },
      { start: 9, end: 9, removed: '', added: ' added' },
      { start: 20, end: 24, removed: 'gone', added: '' },
    ];

    it('shows just what was removed and added, one block per hunk', () => {
      const blocks = buildHunkBlocks(hunks);
      expect(blocks).toHaveLength(3);
      expect(blocks[0]!.segments).toEqual([
        { type: 'removed', text: 'old' },
        { type: 'added', text: 'new' },
      ]);
      expect(blocks[1]!.segments).toEqual([{ type: 'added', text: ' added' }]);
      expect(blocks[2]!.segments).toEqual([{ type: 'removed', text: 'gone' }]);
      expect(blocks.every((b) => !b.cutBefore && !b.cutAfter)).toBe(true);
    });

    it('limits to the applied hunks of a partial accept, keeping their indexes', () => {
      expect(buildHunkBlocks(hunks, [0, 2]).map((b) => b.hunkIndex)).toEqual([0, 2]);
    });

    it('drops carriage returns', () => {
      const [block] = buildHunkBlocks([{ start: 0, end: 4, removed: 'a\r\nb', added: 'c' }]);
      expect(block!.segments[0]!.text).toBe('a\nb');
    });
  });
});
