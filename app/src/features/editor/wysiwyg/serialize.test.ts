import type { Mark, Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';

import { sameMeaning } from './equivalence';
import { parseDocument } from './parse';
import { schema } from './schema';
import { DEFAULT_STYLE, detectStyle, escapeText, reads, serializeVerified } from './serialize';
import { randomDocument } from './test-docs';

const { nodes, marks } = schema;
const strong = marks['strong']!.create();
const em = marks['em']!.create();
const code = marks['code']!.create();
const link = (href: string, title = '') => marks['link']!.create({ href, title });
const text = (value: string, ...m: Mark[]) => schema.text(value, m);
const p = (...children: PMNode[]) => nodes['paragraph']!.create(null, children);
const atom = (source: string, kind = 'math', label = '') =>
  nodes['atom_inline']!.create({ source, kind, label });

const out = (node: PMNode, style = DEFAULT_STYLE) => serializeVerified(node, style)?.src ?? null;
const parseBlock = (source: string) =>
  parseDocument(source, { trailingParagraph: false }).segments[0]!.node;

describe('serializeVerified writes Markdown that reads back as the block', () => {
  it('writes marks the way the document does', () => {
    expect(out(p(text('a '), text('b', strong), text(' and '), text('c', em)))).toBe(
      'a **b** and *c*',
    );
    expect(
      out(p(text('a '), text('b', strong), text(' and '), text('c', em)), {
        ...DEFAULT_STYLE,
        emphasis: '_',
        strong: '__',
      }),
    ).toBe('a __b__ and _c_');
  });

  it('writes inline code with as many backticks as it needs', () => {
    expect(out(p(text('use '), text('a', code), text('!')))).toBe('use `a`!');
    expect(out(p(text('a`b', code)))).toBe('``a`b``');
    expect(out(p(text('``', code)))).toBe('` `` `');
  });

  it('writes links with their title, and a target with spaces in angle brackets', () => {
    expect(out(p(text('x', link('https://a.b', 't'))))).toBe('[x](https://a.b "t")');
    expect(out(p(text('x', link('a b'))))).toBe('[x](<a b>)');
  });

  it('moves edge whitespace out of emphasis (Markdown does not open emphasis next to a space)', () => {
    expect(out(p(text('a ', strong), text('b')))).toBe('**a** b');
    expect(out(p(text('a'), text(' b', strong)))).toBe('a **b**');
    expect(out(p(text('x'), text(' ', strong), text('y')))).toBe('x y');
  });

  it('keeps atoms, with the marks around them', () => {
    expect(
      out(
        p(text('see '), atom('$x^2$', 'math', 'x^2'), text(' and '), atom('[@k]', 'citation', 'k')),
      ),
    ).toBe('see $x^2$ and [@k]');
    expect(out(p(atom('$x$', 'math', 'x').mark([strong])))).toBe('**$x$**');
  });

  it('writes hard breaks in the document style, and not a dangling one', () => {
    const hard = nodes['hard_break']!.create();
    expect(out(p(text('a'), hard, text('b')))).toBe('a\\\nb');
    expect(out(p(text('a'), hard, text('b')), { ...DEFAULT_STYLE, hardBreak: '  ' })).toBe(
      'a  \nb',
    );
    expect(out(p(text('a'), hard))).toBe('a');
  });

  it('writes soft breaks as line breaks inside containers with their prefix', () => {
    const soft = nodes['soft_break']!.create();
    const quote = nodes['blockquote']!.create(null, [p(text('a'), soft, text('b'))]);
    expect(out(quote)).toBe('> a\n> b');
    const list = nodes['bullet_list']!.create({ marker: '-', tight: true }, [
      nodes['list_item']!.create(null, [p(text('a'), soft, text('b'))]),
    ]);
    expect(out(list)).toBe('- a\n  b');
  });

  it('writes headings (ATX, and setext when that is what the block was)', () => {
    expect(out(nodes['heading']!.create({ level: 2 }, [text('Title')]))).toBe('## Title');
    expect(out(nodes['heading']!.create({ level: 1, setext: true }, [text('Title')]))).toBe(
      'Title\n=====',
    );
    expect(out(nodes['heading']!.create({ level: 3 }))).toBe('###');
  });

  it('writes lists with the marker, numbering and nesting of the original', () => {
    const item = (...children: PMNode[]) => nodes['list_item']!.create(null, children);
    const inner = nodes['bullet_list']!.create({ marker: '*', tight: true }, [item(p(text('b')))]);
    const list = nodes['bullet_list']!.create({ marker: '*', tight: true }, [
      item(p(text('a')), inner),
      item(p(text('c'))),
    ]);
    expect(out(list)).toBe('* a\n  * b\n* c');
    const ordered = nodes['ordered_list']!.create({ start: 3, delim: ')', step: 1, tight: false }, [
      item(p(text('x'))),
      item(p(text('y'))),
    ]);
    expect(out(ordered)).toBe('3) x\n\n4) y');
    const same = nodes['ordered_list']!.create({ start: 1, delim: '.', step: 0, tight: true }, [
      item(p(text('x'))),
      item(p(text('y'))),
    ]);
    expect(out(same)).toBe('1. x\n1. y');
  });

  it('writes an empty list item and an empty quote line without trailing spaces', () => {
    const list = nodes['bullet_list']!.create({ marker: '-', tight: true }, [
      nodes['list_item']!.create(null, [p()]),
    ]);
    expect(out(list)).toBe('-');
    const quote = nodes['blockquote']!.create(null, [p(text('a')), p(), p(text('b'))]);
    // The empty paragraph between has no source of its own.
    expect(out(quote)).toBe('> a\n>\n> b');
    expect(out(nodes['blockquote']!.create(null, [p()]))).toBe('>');
  });

  it('writes code with a fence longer than any run of backticks inside, or in the original style', () => {
    const block = nodes['code_block']!.create({ info: 'py', fence: '`' }, [text('a\n```\nb')]);
    expect(out(block)).toBe('````py\na\n```\nb\n````');
    const tilde = nodes['code_block']!.create({ info: '', fence: '~' }, [text('x')]);
    expect(out(tilde)).toBe('~~~\nx\n~~~');
    const indent = nodes['code_block']!.create({ info: '', fence: 'indent' }, [text('a\n\nb')]);
    expect(out(indent)).toBe('    a\n\n    b');
    // Indented code cannot hold leading or trailing blank lines: it becomes fenced instead.
    const blank = nodes['code_block']!.create({ info: '', fence: 'indent' }, [text('\na')]);
    expect(out(blank)).toBe('```\n\na\n```');
  });

  it('writes code inside a list with the list indentation, blank lines without it', () => {
    const list = nodes['bullet_list']!.create({ marker: '-', tight: true }, [
      nodes['list_item']!.create(null, [
        p(text('a')),
        nodes['code_block']!.create({ info: '', fence: '`' }, [text('x\n\ny')]),
      ]),
    ]);
    expect(out(list)).toBe('- a\n\n  ```\n  x\n\n  y\n  ```');
  });

  it('writes an atom block exactly as it came', () => {
    const table = nodes['atom_block']!.create({ source: '| a |\n| - |\n| 1 |', kind: 'table' });
    expect(out(table)).toBe('| a |\n| - |\n| 1 |');
  });
});

describe('serializeVerified escapes as little as it can, and as much as it must', () => {
  it('leaves ordinary punctuation alone', () => {
    expect(out(p(text('2 * 3 = 6, snake_case, a_b, 5 < 7 & more')))).toBe(
      '2 * 3 = 6, snake_case, a_b, 5 < 7 & more',
    );
  });

  it('escapes what would turn into emphasis, code, a link, a tag, strikethrough', () => {
    for (const literal of [
      '*not em* here',
      '_not em_ here',
      'a `tick` b',
      'a [b](c) d',
      '<b>x</b>',
      '~~no~~ and ~one~',
    ]) {
      const src = out(p(text(literal)));
      expect(src, literal).not.toBeNull();
      expect(sameMeaning([p(text(literal))], [parseBlock(src!)])).toBe(true);
    }
    expect(out(p(text('*not em* here')))).toBe('\\*not em\\* here');
  });

  it('escapes an entity-looking text and a backslash before punctuation', () => {
    expect(out(p(text('a &amp; b')))).toBe('a \\&amp; b');
    expect(out(p(text('a \\* b')))).toBe('a \\\\* b');
  });

  it('escapes a line that would become a heading, a list, a quote, a fence or a rule', () => {
    for (const literal of [
      '# not a heading',
      '1. not a list',
      '- not a bullet',
      '> not a quote',
      '```',
      '---',
      '+ x',
    ]) {
      const src = out(p(text(literal)));
      expect(src, literal).not.toBeNull();
      const parsed = parseBlock(src!);
      expect(parsed.type.name, literal).toBe('paragraph');
    }
    expect(out(p(text('# not a heading')))).toBe('\\# not a heading');
    expect(out(p(text('1. not a list')))).toBe('1\\. not a list');
  });

  it('escapes at the start of a line after a line break too', () => {
    const soft = nodes['soft_break']!.create();
    expect(out(p(text('a'), soft, text('# b')))).toBe('a\n\\# b');
  });

  it('does not escape $ or a citation: they are text until the block is read again', () => {
    expect(out(p(text('costs $5 and $6')))).toBe('costs $5 and $6');
    expect(out(p(text('as in [@lamport_1982] ok')))).toBe('as in [@lamport_1982] ok');
    expect(out(p(text('$x^2$')))).toBe('$x^2$');
  });

  it('turns typed $$x$$ into a paragraph of literal text now and a formula when read again', () => {
    const node = p(text('$$x^2$$'));
    expect(out(node)).toBe('$$x^2$$');
    expect(parseBlock('$$x^2$$').type.name).toBe('atom_block');
  });

  it('escapes brackets inside link text', () => {
    expect(out(p(text('a [b] c', link('https://x.y'))))).toBe('[a \\[b\\] c](https://x.y)');
  });

  it('refuses a paragraph that cannot be written (four leading spaces would make it code)', () => {
    expect(serializeVerified(p(text('    x')), DEFAULT_STYLE)).toBeNull();
  });

  it('refuses a mark that cannot be written (emphasis closing against punctuation before a letter)', () => {
    const node = p(text('a'), text('"x"', strong), text('b'));
    const written = serializeVerified(node, DEFAULT_STYLE);
    // Either it found a way that reads back identically, or it refuses: never a silent change.
    if (written) expect(reads(written.src, node)).toBe(true);
  });
});

describe('escapeText', () => {
  const ctx = {
    level: 1 as const,
    lineStart: false,
    lineEnd: false,
    inLink: false,
    trimEnd: false,
  };

  it('reports where each character went when it adds escapes', () => {
    const escaped = escapeText('a*b', ctx);
    expect(escaped.str).toBe('a\\*b');
    expect([...escaped.starts!]).toEqual([0, 2, 3]);
    expect([...escaped.ends!]).toEqual([1, 3, 4]);
  });

  it('has no arrays when the text is copied as it is', () => {
    expect(escapeText('plain text', ctx)).toEqual({ str: 'plain text' });
  });

  it('drops trailing spaces before a line break', () => {
    const escaped = escapeText('a  ', { ...ctx, trimEnd: true });
    expect(escaped.str).toBe('a');
    expect([...escaped.starts!]).toEqual([0, 1, 1]);
  });

  it('escapes every meaningful punctuation character at level 2', () => {
    expect(escapeText('$[x]!', { ...ctx, level: 2 }).str).toBe('\\$\\[x\\]\\!');
  });
});

describe('detectStyle', () => {
  it('reads emphasis, strong and hard-break style from the text', () => {
    expect(detectStyle('a _b_ and _c_ and __d__\\\ne')).toEqual({
      emphasis: '_',
      strong: '__',
      hardBreak: '\\',
    });
    expect(detectStyle('a *b* and **d**  \ne')).toEqual({
      emphasis: '*',
      strong: '**',
      hardBreak: '  ',
    });
    expect(detectStyle('plain')).toEqual(DEFAULT_STYLE);
  });
});

describe('serializing every editable block of random documents', () => {
  it('always reads back as the block (500 documents)', () => {
    let blocks = 0;
    for (let seed = 1; seed <= 500; seed += 1) {
      const doc = parseDocument(randomDocument(seed));
      for (const segment of doc.segments) {
        if (segment.src === '') continue;
        blocks += 1;
        const written = serializeVerified(segment.node, DEFAULT_STYLE);
        if (!written) throw new Error(`seed ${seed}: refused ${JSON.stringify(segment.src)}`);
        expect(
          reads(written.src, segment.node),
          `seed ${seed} ${JSON.stringify(segment.src)}`,
        ).toBe(true);
      }
    }
    expect(blocks).toBeGreaterThan(1500);
  });

  it('is idempotent: writing what it wrote gives the same text', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const doc = parseDocument(randomDocument(seed));
      for (const segment of doc.segments) {
        if (segment.src === '' || segment.node.type.name === 'atom_block') continue;
        const first = serializeVerified(segment.node, DEFAULT_STYLE)?.src;
        const twice = serializeVerified(parseBlock(first!), DEFAULT_STYLE)?.src;
        expect(twice, `seed ${seed}`).toBe(first);
      }
    }
  });
});
