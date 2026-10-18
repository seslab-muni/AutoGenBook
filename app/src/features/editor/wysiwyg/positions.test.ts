import { describe, expect, it } from 'vitest';

import { CodePointIndex } from '@/features/editor/lib/anchors';

import { EditorCore } from './core';
import { pmToSrc, srcToPm, type InlineMap } from './inline-map';
import { randomDocument } from './test-docs';

const token = (
  pm: number,
  len: number,
  s: number,
  e: number,
  kind: 'text' | 'atom' | 'break' = 'text',
  extra: { starts?: number[]; ends?: number[] } = {},
) => ({
  pm,
  len,
  s,
  e,
  kind,
  marks: '',
  ...(extra.starts ? { starts: Int32Array.from(extra.starts) } : {}),
  ...(extra.ends ? { ends: Int32Array.from(extra.ends) } : {}),
});

describe('inline maps', () => {
  // `ab **cd** $x$ ef`: "ab " (0-3), "cd" inside the stars (5-7), an atom (9-12), " ef" (12-15).
  const map: InlineMap = [
    token(0, 3, 0, 3),
    token(3, 2, 5, 7),
    token(5, 1, 9, 12, 'atom'),
    token(6, 3, 12, 15),
  ];

  it('maps a position inside text one to one', () => {
    expect(pmToSrc(map, 1, 'start')).toBe(1);
    expect(pmToSrc(map, 4, 'end')).toBe(6);
  });

  it('hugs the text on the side the edge asks for at a boundary with delimiters', () => {
    // Between "ab " and "cd": a range starting there starts at the "c", one ending there ends after the space.
    expect(pmToSrc(map, 3, 'start')).toBe(5);
    expect(pmToSrc(map, 3, 'end')).toBe(3);
    expect(pmToSrc(map, 5, 'end')).toBe(7);
    expect(pmToSrc(map, 5, 'start')).toBe(9);
  });

  it('takes an atom whole', () => {
    expect(pmToSrc(map, 5, 'start')).toBe(9);
    expect(pmToSrc(map, 6, 'end')).toBe(12);
  });

  it('maps source back, snapping delimiters forward for a start and backward for an end', () => {
    expect(srcToPm(map, 5, 'start')).toBe(3);
    expect(srcToPm(map, 4, 'start')).toBe(3);
    expect(srcToPm(map, 4, 'end')).toBe(3);
    expect(srcToPm(map, 7, 'end')).toBe(5);
    expect(srcToPm(map, 8, 'end')).toBe(5);
    expect(srcToPm(map, 8, 'start')).toBe(5);
    expect(srcToPm(map, 10, 'start')).toBe(5);
    expect(srcToPm(map, 10, 'end')).toBe(6);
    expect(srcToPm(map, 14, 'end')).toBe(8);
  });

  it('maps text whose characters are not a copy of the source (an escape and an entity)', () => {
    // Source `a\*b&amp;c`: value `a*b&c`.
    const escaped: InlineMap = [
      token(0, 5, 0, 10, 'text', { starts: [0, 2, 3, 4, 9], ends: [1, 3, 4, 9, 10] }),
    ];
    expect(pmToSrc(escaped, 1, 'end')).toBe(1);
    expect(pmToSrc(escaped, 1, 'start')).toBe(2);
    expect(pmToSrc(escaped, 3, 'start')).toBe(4);
    expect(pmToSrc(escaped, 4, 'end')).toBe(9);
    expect(srcToPm(escaped, 2, 'start')).toBe(1);
    expect(srcToPm(escaped, 6, 'start')).toBe(3);
    expect(srcToPm(escaped, 6, 'end')).toBe(4);
    expect(srcToPm(escaped, 9, 'start')).toBe(4);
  });

  it('answers 0 for a textblock with no content', () => {
    expect(pmToSrc([], 0, 'start')).toBe(0);
    expect(srcToPm([], 3, 'end')).toBe(0);
  });
});

/** Every position inside a run of editable text, with the character that follows it. */
function textPositions(core: EditorCore): { pos: number; char: string }[] {
  const out: { pos: number; char: string }[] = [];
  core.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const text = node.text!;
    for (let i = 0; i < text.length; i += 1) out.push({ pos: pos + i, char: text[i]! });
    return false;
  });
  return out;
}

describe('SourceModel positions agree with the text', () => {
  it('maps every typed character to itself in the source, and back (400 documents)', () => {
    let checked = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const core = new EditorCore(randomDocument(seed));
      const text = core.text;
      for (const { pos, char } of textPositions(core)) {
        const at = core.model.posToSrc(pos, 'start');
        const here = text.slice(at, at + 1);
        // An entity (`&amp;`) starts with its own `&`; every other character is itself.
        if (here !== char && here !== '&') {
          throw new Error(`seed ${seed} pos ${pos}: ${char} vs ${here} in ${JSON.stringify(text)}`);
        }
        if (here === char) {
          expect(core.model.srcToPos(at, 'start'), `seed ${seed} pos ${pos}`).toBe(pos);
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20000);
  });

  it('turns a source range into the editor ranges and atoms it covers', () => {
    const core = new EditorCore(
      'Hello **bold** and $x$ [@k] end\n\nSecond paragraph\n\n| a |\n| - |\n| 1 |\n',
    );
    const text = core.text;
    const bold = text.indexOf('bold');
    const first = core.model.rangesForSource(bold, bold + 4);
    expect(first.atoms).toEqual([]);
    expect(core.doc.textBetween(first.text[0]!.from, first.text[0]!.to)).toBe('bold');
    // A range over text, an inline atom and a citation: one text range, two atoms.
    const wide = core.model.rangesForSource(text.indexOf('and'), text.indexOf('end') + 3);
    expect(wide.atoms).toHaveLength(2);
    expect(core.doc.textBetween(wide.text[0]!.from, wide.text[0]!.to, '', '¤')).toBe('and ¤ ¤ end');
    // A range over a block atom (a table) is the atom, not text.
    const table = text.indexOf('| a |');
    const over = core.model.rangesForSource(table, table + 5);
    expect(over.text).toEqual([]);
    expect(over.atoms).toHaveLength(1);
    expect(core.doc.nodeAt(over.atoms[0]!)!.type.name).toBe('atom_block');
  });

  it('spans paragraphs: one text range per textblock', () => {
    const core = new EditorCore('First one\n\nSecond one\n');
    const text = core.text;
    const ranges = core.model.rangesForSource(text.indexOf('one'), text.indexOf('Second') + 6);
    expect(ranges.text).toHaveLength(2);
    expect(ranges.text.map((r) => core.doc.textBetween(r.from, r.to))).toEqual(['one', 'Second']);
  });

  it('counts UTF-16 units on both sides, so astral characters map exactly', () => {
    const core = new EditorCore('a 😀 b 𝒳 c\n');
    const text = core.text;
    const x = text.indexOf('𝒳');
    const range = core.model.rangesForSource(x, x + 2);
    expect(core.doc.textBetween(range.text[0]!.from, range.text[0]!.to)).toBe('𝒳');
    // Code points: the draft's selection offsets are code points (CodePointIndex converts).
    const index = new CodePointIndex(text);
    expect(index.toCp(x)).toBe(x - 1);
  });

  it('puts a position in an empty trailing paragraph at the end of the last block', () => {
    const core = new EditorCore('```\ncode\n```\n');
    // doc: code_block, empty paragraph
    const end = core.doc.content.size - 1;
    expect(core.model.posToSrc(end, 'start')).toBe('```\ncode\n```'.length);
  });

  it('keeps ranges after an edit: typing before moves the source offsets by the typed length', () => {
    const core = new EditorCore('Alpha beta gamma\n\nDelta\n');
    const before = core.model.rangesForSource(
      core.text.indexOf('gamma'),
      core.text.indexOf('gamma') + 5,
    );
    const typed = core.apply(core.state.tr.insertText('XYZ', 2));
    expect(typed.ok).toBe(true);
    const gamma = core.text.indexOf('gamma');
    const after = core.model.rangesForSource(gamma, gamma + 5);
    expect(after.text[0]!.from).toBe(before.text[0]!.from + 3);
    expect(core.doc.textBetween(after.text[0]!.from, after.text[0]!.to)).toBe('gamma');
  });
});
