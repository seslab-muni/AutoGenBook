import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';

import { normalizeEol } from '@/features/editor/lib/eol';

import { parseDocument } from './parse';
import { randomDocument } from './test-docs';

const rebuild = (text: string) => {
  const parsed = parseDocument(text);
  return parsed.segments.map((s) => s.gap + s.src).join('') + parsed.tail;
};

const kinds = (text: string) =>
  parseDocument(text, { trailingParagraph: false }).segments.map((s) =>
    s.node.type.name === 'atom_block' ? `atom:${s.node.attrs['kind'] as string}` : s.node.type.name,
  );

function inlineKinds(node: PMNode): string[] {
  const out: string[] = [];
  node.descendants((child) => {
    if (child.type.name === 'atom_inline') out.push(`atom:${child.attrs['kind'] as string}`);
    return true;
  });
  return out;
}

describe('parseDocument: the source is kept byte for byte', () => {
  const cases: Record<string, string> = {
    empty: '',
    'only newlines': '\n\n\n',
    'only spaces': '   \n  \n',
    'single paragraph, no newline': 'Hello',
    'single paragraph, newline': 'Hello\n',
    'leading and trailing blank lines': '\n\nHello\n\n\n',
    'trailing spaces at the end': 'Hello  \n',
    'hard break by spaces': 'one  \ntwo',
    'hard break by backslash': 'one\\\ntwo',
    'indented first line': '  indented paragraph\n\nnext',
    'many blank lines between blocks': 'a\n\n\n\n\nb',
    'single newline between a paragraph and math': 'text\n$$\nx\n$$\nmore',
    'one-line display math': 'before\n\n$$x^2$$\n\nafter',
    'document that is a single atom': '| a | b |\n| - | - |\n| 1 | 2 |\n',
    'document that is a single formula': '$$\nx\n$$',
    'astral characters': 'A 😀 and 𝒳 and café and データ\n\n# Ünïcode 😀\n',
    'tabs and odd spaces': 'a\tb\n\n\tcode?\n\n    indented code\n',
    'setext headings': 'Title\n=====\n\nSub\n---\n',
    'nested lists': '- a\n  - b\n    - c\n- d\n\n1. x\n   1. y\n2. z\n',
    'loose list': '- a\n\n- b\n\n- c\n',
    'task list': '- [ ] todo\n- [x] done\n',
    'block quote with a list': '> - a\n> - b\n>\n> text\n',
    'fenced code with a fence inside': '````\n```\ninner\n```\n````\n',
    'tilde fence': '~~~python\nx = 1\n~~~\n',
    'unclosed fence': '```\nnever closed\n',
    'html comment and block': '<!-- note -->\n\n<div>\nblock\n</div>\n',
    footnotes: 'ref[^1]\n\n[^1]: the note\n',
    'link definition': '[a]: http://example.com "t"\n\n[a] is a link\n',
    'thematic breaks': 'a\n\n---\n\n***\n\n___\n',
    'entities and escapes': 'a &amp; b &lt; \\*c\\* \\\\ &#128512;\n',
    citations: 'See [@a; @b] and \\cite{c,d} and [@e].\n',
    'inline code with backticks': 'use `` a`b `` and `x`\n',
    'images and autolinks': '![alt](a.png) <https://x.y> https://bare.example/path\n',
    callout: '> **Theorem 1** Statement $x$.\n> More.\n',
    'crlf-free text with a lone cr': 'a\rb',
  };
  for (const [name, text] of Object.entries(cases)) {
    it(name, () => {
      const normalized = normalizeEol(text);
      expect(rebuild(normalized)).toBe(normalized);
    });
  }

  it('holds for 500 random documents, with astral characters, math, citations and every block kind', () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const text = randomDocument(seed);
      if (rebuild(text) !== text) throw new Error(`seed ${seed}: ${JSON.stringify(text)}`);
    }
  });

  it('counts a CR LF document over LF, like the Source view (lib/eol)', () => {
    const crlf = 'one\r\n\r\ntwo\r\n';
    expect(rebuild(normalizeEol(crlf))).toBe('one\n\ntwo\n');
  });
});

describe('parseDocument: what is editable and what is an atom', () => {
  it('reads paragraphs, headings, lists, quotes and code as editable blocks', () => {
    expect(kinds('# h\n\np\n\n- a\n\n1. b\n\n> q\n\n```\nc\n```\n')).toEqual([
      'heading',
      'paragraph',
      'bullet_list',
      'ordered_list',
      'blockquote',
      'code_block',
    ]);
  });

  it('makes tables, display math, callouts, html, footnotes, definitions and rules atoms', () => {
    const text = [
      '| a | b |\n| - | - |\n| 1 | 2 |',
      '$$\nx\n$$',
      '> **Lemma** text',
      '<div>x</div>',
      '[^1]: note',
      '[a]: http://x.y',
      '---',
    ].join('\n\n');
    expect(kinds(text)).toEqual([
      'atom:table',
      'atom:math',
      'atom:callout',
      'atom:html',
      'atom:footnote',
      'atom:definition',
      'atom:rule',
    ]);
  });

  it('keeps a block quote that is not a callout editable', () => {
    expect(kinds('> **Bold** is not a callout\n')).toEqual(['blockquote']);
  });

  it('makes a one-line $$x$$ a display formula, as the read-only view does', () => {
    const parsed = parseDocument('$$x^2$$\n', { trailingParagraph: false });
    const atom = parsed.segments[0]!.node;
    expect(atom.attrs['kind']).toBe('math');
    expect(atom.attrs['source']).toBe('$$x^2$$');
  });

  it('keeps inline math, citations, html, footnote references and images as inline atoms with their exact source', () => {
    const text =
      'a $x^2$ b [@k1; @k2] c \\cite{k3} d <b>x</b> e[^1] f ![alt](a.png) g\n\n[^1]: n\n';
    const paragraph = parseDocument(text).segments[0]!.node;
    expect(inlineKinds(paragraph)).toEqual([
      'atom:math',
      'atom:citation',
      'atom:citation',
      'atom:html',
      'atom:html',
      'atom:footnote',
      'atom:image',
    ]);
    const sources: string[] = [];
    paragraph.descendants((n) => {
      if (n.type.name === 'atom_inline') sources.push(n.attrs['source'] as string);
      return true;
    });
    expect(sources).toEqual([
      '$x^2$',
      '[@k1; @k2]',
      '\\cite{k3}',
      '<b>',
      '</b>',
      '[^1]',
      '![alt](a.png)',
    ]);
  });

  it('reads a text link as a mark and an autolink as an atom', () => {
    const paragraph = parseDocument('[text](https://a.b "t") and <https://c.d>\n').segments[0]!
      .node;
    expect(paragraph.firstChild!.marks[0]!.type.name).toBe('link');
    expect(paragraph.firstChild!.marks[0]!.attrs['title']).toBe('t');
    expect(inlineKinds(paragraph)).toEqual(['atom:link']);
  });

  it('keeps a task list whole as a raw atom (it cannot be written faithfully)', () => {
    expect(kinds('- [ ] a\n- [x] b\n')).toEqual(['atom:raw']);
  });

  it('keeps a list with a table or a formula inside whole as a raw atom', () => {
    expect(kinds('- item\n\n  | a |\n  | - |\n  | 1 |\n')).toEqual(['atom:raw']);
    expect(kinds('- item\n\n  $$\n  x\n  $$\n')).toEqual(['atom:raw']);
  });

  it('reads a multi-line inline atom in a top-level paragraph, but not inside a container', () => {
    expect(kinds('a $x\ny$ b\n')).toEqual(['paragraph']);
    expect(kinds('> a $x\n> y$ b\n')).toEqual(['atom:raw']);
  });

  it('marks setext headings and indented code so the style survives an edit', () => {
    const heading = parseDocument('Title\n=====\n').segments[0]!.node;
    expect(heading.attrs['setext']).toBe(true);
    const code = parseDocument('    indented\n').segments[0]!.node;
    expect(code.attrs['fence']).toBe('indent');
  });
});

describe('parseDocument: the document around the blocks', () => {
  it('keeps the whitespace before, between and after blocks', () => {
    const parsed = parseDocument('\n\n# a\n\n\nb\n\n');
    expect(parsed.segments.map((s) => s.gap)).toEqual(['\n\n', '\n\n\n']);
    expect(parsed.tail).toBe('\n\n');
  });

  it('gives an empty document one empty paragraph with no source', () => {
    const parsed = parseDocument('');
    expect(parsed.doc.childCount).toBe(1);
    expect(parsed.segments[0]!.src).toBe('');
  });

  it('keeps a whitespace-only document as its tail', () => {
    const parsed = parseDocument('  \n\n');
    expect(parsed.tail).toBe('  \n\n');
    expect(parsed.segments).toHaveLength(1);
  });

  it('adds a place to type after a last block that is not a paragraph, and before a first atom', () => {
    const parsed = parseDocument('| a |\n| - |\n| 1 |\n');
    expect(parsed.segments.map((s) => s.src === '')).toEqual([true, false, true]);
    expect(parsed.doc.firstChild!.type.name).toBe('paragraph');
    expect(parsed.doc.lastChild!.type.name).toBe('paragraph');
  });

  it('keeps ordered list numbering, markers and tightness for the serializer', () => {
    const list = parseDocument('1) a\n1) b\n').segments[0]!.node;
    expect(list.attrs).toMatchObject({ delim: ')', step: 0, tight: true });
    const bullets = parseDocument('* a\n\n* b\n').segments[0]!.node;
    expect(bullets.attrs).toMatchObject({ marker: '*', tight: false });
  });
});
