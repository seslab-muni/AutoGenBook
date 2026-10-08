import { toggleMark } from 'prosemirror-commands';
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';

import {
  agrees,
  atSource,
  dump,
  makeDriver,
  meanings,
  pressKey,
  setSelection,
  typeText,
  type Driver,
} from './core-driver';
import { parseDocument } from './parse';
import { schema } from './schema';

const { marks } = schema;

function open(text: string, needle: string, offset = 0, length = 0): Driver {
  const driver = makeDriver(text);
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`no ${needle}`);
  setSelection(
    driver.core,
    atSource(driver.core, at + offset),
    length ? atSource(driver.core, at + offset + length) : undefined,
  );
  return driver;
}

const check = (driver: Driver) => {
  expect(agrees(driver.core), `${JSON.stringify(driver.core.text)}\n${dump(driver.core.doc)}`).toBe(
    true,
  );
};

/** Every atom of a kind in the whole source, read again. */
function atomsRead(text: string): string[] {
  const out: string[] = [];
  parseDocument(text, { trailingParagraph: false }).doc.descendants((node: PMNode) => {
    if (node.type.name === 'atom_inline' || node.type.name === 'atom_block') {
      out.push(`${node.attrs['kind'] as string}:${node.attrs['source'] as string}`);
    }
    return true;
  });
  return out;
}

function toggle(driver: Driver, mark: 'strong' | 'em' | 'code') {
  let result: ReturnType<typeof driver.core.apply> | null = null;
  toggleMark(marks[mark]!)(driver.core.state, (tr) => {
    result = driver.core.apply(tr);
  });
  return result as ReturnType<typeof driver.core.apply> | null;
}

describe('plain typing is never refused and never altered', () => {
  const cases: [string, string][] = [
    ['See', ' www.example.com now'],
    ['See', ' www.'],
    ['See', ' http://example.com/a_b?c=d&e=f.'],
    ['Mail', ' me@example.org, or you@x.io.'],
    ['Done', ' (see https://x.y/z).'],
  ];

  for (const [start, typed] of cases) {
    it(`types ${JSON.stringify(typed)} after ${JSON.stringify(start)}`, () => {
      const driver = open(`${start}\n`, start, start.length);
      const results = typeText(driver, typed);
      expect(results.every((result) => result.ok)).toBe(true);
      // The source keeps exactly what was typed, readable.
      expect(driver.core.text).toBe(`${start}${typed}\n`);
      check(driver);
    });
  }

  it('an address typed right before emphasised text keeps every character', () => {
    const driver = open('See *this* now\n', '*this*', 0);
    const results = typeText(driver, 'http://x.y/a');
    expect(results.every((result) => result.ok)).toBe(true);
    check(driver);
    // The address is ended where it ends, and nothing after the slashes is lost.
    expect(driver.core.doc.textContent).toBe('See http://x.y/athis now');
    expect(driver.core.text).toContain('http://x.y/a');
    expect(driver.core.text).toContain('*this*');
  });

  it('www. typed right before emphasised text keeps every character', () => {
    const driver = open('See *this* now\n', '*this*', 0);
    const results = typeText(driver, 'www.a.b');
    expect(results.every((result) => result.ok)).toBe(true);
    check(driver);
    expect(driver.core.doc.textContent).toBe('See www.a.bthis now');
  });

  it('no printable character is refused or changed in the text, at the end of a few paragraphs', () => {
    const bases = [
      'Plain prose here.',
      'Some **bold** words and `code`.',
      '# A heading',
      '- an item\n- another',
      '> a quote',
      'A [link](https://x.y) and $x$ and [@k].',
    ];
    const chars = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
    for (const base of bases) {
      for (const char of chars) {
        const driver = makeDriver(`${base}\n`);
        // The caret at the end of the first textblock's text.
        let end = 0;
        driver.core.doc.descendants((node, pos) => {
          if (node.isTextblock && end === 0) end = pos + 1 + node.content.size;
          return end === 0;
        });
        setSelection(driver.core, end);
        const textblock = () => {
          let text = '';
          let found = false;
          driver.core.doc.descendants((node) => {
            if (!found && node.isTextblock) {
              found = true;
              text = node.textContent;
            }
            return !found;
          });
          return text;
        };
        const before = textblock();
        const results = typeText(driver, char);
        expect(
          results.every((result) => result.ok),
          `${JSON.stringify(base)} + ${char}`,
        ).toBe(true);
        expect(textblock(), `${JSON.stringify(base)} + ${char}`).toBe(before + char);
        check(driver);
      }
    }
  });
});

describe('what stays literal text', () => {
  const typed = (start: string, text: string, definitions = '') => {
    const driver = open(`${start}\n${definitions}`, start, start.length);
    typeText(driver, ` ${text}`);
    check(driver);
    return driver;
  };

  it('a < b and c > d is not inline HTML', () => {
    const driver = typed('Start', 'a<b and c>d');
    expect(driver.core.text).toContain('a\\<b and c>d');
    expect(atomsRead(driver.core.text)).toEqual([]);
  });

  it('![a](u) is not an image, and [a](u) typed out is not a link', () => {
    const driver = typed('Start', '![a](u) and [b](v)');
    expect(atomsRead(driver.core.text)).toEqual([]);
    expect(driver.core.doc.textContent).toContain('![a](u) and [b](v)');
  });

  it('[foo] and [^1] are text even when a definition elsewhere would turn them into references', () => {
    const driver = typed(
      'Start ',
      'see [foo] and [^1] and [text][foo]',
      '\n[foo]: https://example.com\n\n[^1]: A footnote.\n',
    );
    const kinds = atomsRead(driver.core.text).map((atom) => atom.split(':')[0]);
    // Only the definitions themselves are atoms.
    expect(kinds.sort()).toEqual(['definition', 'footnote']);
    expect(driver.core.doc.textContent).toContain('see [foo] and [^1] and [text][foo]');
  });

  it('$...$ on one line with something other than space inside its edges is a formula, any other $ is text', () => {
    const formula = typed('Start', 'then $x^2$ ok');
    expect(formula.core.text).toContain('$x^2$');
    expect(atomsRead(formula.core.text)).toEqual(['math:$x^2$']);

    const prices = typed('Start', 'costs $5 and $6');
    expect(prices.core.text).toContain('costs \\$5 and \\$6');
    expect(atomsRead(prices.core.text)).toEqual([]);

    const spaced = typed('Start', 'a $ x $ b');
    expect(atomsRead(spaced.core.text)).toEqual([]);
  });
});

describe('marks and keys that used to be refused', () => {
  it('bold on a word inside an italic phrase merges into one emphasis', () => {
    const driver = open('*hello world*\n', 'world', 0, 5);
    expect(toggle(driver, 'strong')?.ok).toBe(true);
    check(driver);
    expect(driver.core.text).toBe('*hello **world***\n');
  });

  it('italic on part of a word in a document that writes _emphasis_ uses a delimiter that works', () => {
    const driver = open('_one_ and _two_ and a word\n', 'word', 1, 2);
    expect(toggle(driver, 'em')?.ok).toBe(true);
    check(driver);
    expect(driver.core.text).toBe('_one_ and _two_ and a w*or*d\n');
  });

  it('a space as the first character of an empty paragraph, and of an empty document', () => {
    const driver = makeDriver('');
    expect(typeText(driver, ' ')[0]!.ok).toBe(true);
    expect(driver.core.text).toBe('');
    const paragraph = open('One\n\nTwo\n', 'Two', 0);
    pressKey(paragraph, 'Enter');
    expect(typeText(paragraph, ' ')[0]!.ok).toBe(true);
    check(paragraph);
  });

  it('Shift+Enter in a heading does nothing, quietly', () => {
    const driver = open('# A heading\n', 'heading', 3);
    const before = driver.core.doc;
    const { handled, result } = pressKey(driver, 'Enter', { shift: true });
    expect(handled).toBe(true);
    expect(result).toBeNull();
    expect(driver.core.doc).toBe(before);
  });

  it('a heading typed on a paragraph that has a hard break', () => {
    const driver = open('first\\\nsecond\n', 'first', 0);
    const results = typeText(driver, '# ');
    expect(results.every((result) => result.ok)).toBe(true);
    check(driver);
    expect(meanings(driver.core.doc)[0]).toContain('"h"');
    expect(driver.core.text).toBe('# first second\n');
  });

  it('bold on quoted CJK text next to letters (emphasis cannot close before a letter)', () => {
    const driver = open('これは「重要」です。\n', '「重要」', 0, 4);
    expect(toggle(driver, 'strong')?.ok).toBe(true);
    check(driver);
    expect(driver.core.text).toBe('これは「**重要**」です。\n');
  });

  it('Enter inside bold text leaves no space before the blank line', () => {
    const driver = open('**foo bar**\n', 'bar', 0);
    pressKey(driver, 'Enter');
    check(driver);
    expect(driver.core.text).toBe('**foo**\n\n**bar**\n');
  });

  it('bold and italic written next to each other are not written as ****', () => {
    const driver = open('hello world again\n', 'world', 0, 5);
    toggle(driver, 'strong');
    toggle(driver, 'em');
    check(driver);
    expect(driver.core.text).not.toContain('****');
    expect(driver.core.text).toBe('hello ***world*** again\n');
  });
});
