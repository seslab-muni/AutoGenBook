import type { Mark, Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';

import { fingerprintString, isBlankParagraph, isCleanMath, sameMeaning } from './equivalence';
import { schema } from './schema';

const { nodes, marks } = schema;
const p = (...children: PMNode[]) => nodes['paragraph']!.create(null, children);
const t = (text: string, ...m: Mark[]) => schema.text(text, m);
const strong = marks['strong']!.create();
const em = marks['em']!.create();
const code = marks['code']!.create();
const strike = marks['strike']!.create();
const link = (href: string, title = '') => marks['link']!.create({ href, title });
const atom = (kind: string, source: string) =>
  nodes['atom_inline']!.create({ kind, source, label: '' });
const same = (a: PMNode, b: PMNode) => sameMeaning([a], [b]);

/**
 * What the serializer's safety net compares. Every mark and every construct that changes what the
 * text means has to make two blocks differ - a mutation that ignores one of them must fail here.
 */
describe('what two blocks are the same as', () => {
  it('a mark is a difference: each of them, on any word', () => {
    for (const mark of [strong, em, code, strike]) {
      expect(same(p(t('one '), t('two', mark), t(' three')), p(t('one two three')))).toBe(false);
    }
    expect(same(p(t('a', strong)), p(t('a', em)))).toBe(false);
    expect(same(p(t('a', strong), t(' b')), p(t('a'), t(' b', strong)))).toBe(false);
  });

  it('a mark on the core of the text is a difference even when punctuation sits at its edge', () => {
    expect(same(p(t('「重要」', strong), t('です')), p(t('「重要」です')))).toBe(false);
    expect(same(p(t('(x)', em)), p(t('(x)')))).toBe(false);
    expect(same(p(t('"a b"', strong)), p(t('"a'), t(' b', strong), t('"')))).toBe(false);
  });

  it('a mark on spaces and punctuation at the edge of emphasised text is not (the serializer moves it out)', () => {
    expect(same(p(t('「', strong), t('重要', strong)), p(t('「'), t('重要', strong)))).toBe(true);
    expect(same(p(t('word ', strong), t('next')), p(t('word', strong), t(' next')))).toBe(true);
  });

  it('a link is its address and its title', () => {
    expect(same(p(t('a', link('https://x.y'))), p(t('a', link('https://x.y'))))).toBe(true);
    expect(same(p(t('a', link('https://x.y'))), p(t('a', link('https://z.y'))))).toBe(false);
    expect(same(p(t('a', link('https://x.y', 'T'))), p(t('a', link('https://x.y'))))).toBe(false);
    expect(same(p(t('a', link('https://x.y'))), p(t('a')))).toBe(false);
  });

  it('code keeps its spaces and its marks apart from the text around it', () => {
    expect(same(p(t('x '), t(' a ', code), t(' y')), p(t('x '), t('a', code), t(' y')))).toBe(
      false,
    );
    expect(same(p(t('a', code), t('b')), p(t('ab')))).toBe(false);
  });

  it('only formulas, citations, references and automatic links are the same as their literal text', () => {
    expect(same(p(atom('math', '$x$')), p(t('$x$')))).toBe(true);
    expect(same(p(atom('citation', '[@k]')), p(t('[@k]')))).toBe(true);
    expect(same(p(atom('reference', '[a][b]')), p(t('[a][b]')))).toBe(true);
    expect(same(p(atom('footnote', '[^1]')), p(t('[^1]')))).toBe(true);
    expect(same(p(atom('link', 'https://x.y')), p(t('https://x.y')))).toBe(true);
    expect(same(p(atom('link', '<https://x.y>')), p(t('https://x.y')))).toBe(true);
    expect(same(p(atom('link', 'www\\.x.y')), p(t('www.x.y')))).toBe(true);
    // Everything else is a construct of its own: text that would read back as one is not equal.
    expect(same(p(atom('html', '<b>')), p(t('<b>')))).toBe(false);
    expect(same(p(atom('image', '![a](u)')), p(t('![a](u)')))).toBe(false);
    expect(same(p(atom('raw', 'x')), p(t('x')))).toBe(false);
    expect(same(p(atom('math', '$x$')), p(atom('html', '$x$')))).toBe(false);
  });

  it('a formula is "$...$" with something other than space inside its edges, on one line', () => {
    expect(isCleanMath('$x^2$')).toBe(true);
    expect(isCleanMath('$$x$$')).toBe(true);
    expect(isCleanMath('$ x$')).toBe(false);
    expect(isCleanMath('$5 and $')).toBe(false);
    expect(isCleanMath('$$')).toBe(false);
    expect(isCleanMath('$a\nb$')).toBe(false);
    // An unclean "formula" is not text: the literal costs of "$5 and $6" must be escaped.
    expect(same(p(atom('math', '$5 and $')), p(t('$5 and $')))).toBe(false);
  });

  it('block structure: heading levels, list kinds and start numbers, quotes, code and its language', () => {
    const h = (level: number, text: string) => nodes['heading']!.create({ level }, [t(text)]);
    expect(same(h(1, 'a'), h(2, 'a'))).toBe(false);
    expect(same(h(2, 'a'), p(t('a')))).toBe(false);
    const item = (text: string) => nodes['list_item']!.create(null, [p(t(text))]);
    const ul = nodes['bullet_list']!.create(null, [item('a')]);
    const ol = (start: number) => nodes['ordered_list']!.create({ start }, [item('a')]);
    expect(same(ul, ol(1))).toBe(false);
    expect(same(ol(1), ol(2))).toBe(false);
    expect(same(nodes['blockquote']!.create(null, [p(t('a'))]), p(t('a')))).toBe(false);
    const block = (info: string, body: string) =>
      nodes['code_block']!.create({ info }, [schema.text(body)]);
    expect(same(block('js', 'a'), block('ts', 'a'))).toBe(false);
    expect(same(block('js', 'a'), block('js', 'b'))).toBe(false);
  });

  it('what Markdown does not keep is not a difference: markers, tightness, edge spaces, escapes, breaks', () => {
    const item = (text: string) => nodes['list_item']!.create(null, [p(t(text))]);
    const bullet = (marker: string, tight: boolean) =>
      nodes['bullet_list']!.create({ marker, tight }, [item('a')]);
    expect(same(bullet('-', true), bullet('*', false))).toBe(true);
    expect(same(p(t('  a b  ')), p(t('a b')))).toBe(true);
    expect(
      same(
        p(t('a'), nodes['soft_break']!.create(), t('b')),
        p(t('a'), nodes['soft_break']!.create(), t(' b')),
      ),
    ).toBe(true);
    expect(
      same(
        p(t('a'), nodes['soft_break']!.create(), t('b')),
        p(t('a'), nodes['hard_break']!.create(), t('b')),
      ),
    ).toBe(false);
    // A heading is one line: a break in it is a space.
    expect(
      same(
        nodes['heading']!.create({ level: 1 }, [t('a'), nodes['hard_break']!.create(), t('b')]),
        nodes['heading']!.create({ level: 1 }, [t('a b')]),
      ),
    ).toBe(true);
  });

  it('an empty or blank paragraph next to other blocks is nothing, in a container too', () => {
    expect(isBlankParagraph(p())).toBe(true);
    expect(isBlankParagraph(p(t('   '), nodes['hard_break']!.create()))).toBe(true);
    expect(isBlankParagraph(p(t('a')))).toBe(false);
    const item = (...c: PMNode[]) => nodes['list_item']!.create(null, c);
    expect(
      same(
        nodes['bullet_list']!.create(null, [item(p(t('a')), p())]),
        nodes['bullet_list']!.create(null, [item(p(t('a')))]),
      ),
    ).toBe(true);
    // The only child of an item keeps its meaning: an empty item is not no item.
    expect(
      same(
        nodes['bullet_list']!.create(null, [item(p())]),
        nodes['bullet_list']!.create(null, [item(p(t('a')))]),
      ),
    ).toBe(false);
  });

  it('a different number of blocks is a difference, and so is the order', () => {
    expect(sameMeaning([p(t('a')), p(t('b'))], [p(t('a'))])).toBe(false);
    expect(sameMeaning([p(t('a')), p(t('b'))], [p(t('b')), p(t('a'))])).toBe(false);
    expect(fingerprintString(p(t('a')))).not.toBe(fingerprintString(p(t('b'))));
  });
});
