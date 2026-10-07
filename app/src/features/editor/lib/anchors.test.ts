import { describe, expect, it } from 'vitest';

import {
  CodePointIndex,
  codePointLength,
  diffChange,
  isOrphaned,
  makeAnchor,
  mapAnchorThroughChange,
  mapRangeThroughChange,
  resolveAnchor,
  resolveAnchorUnits,
} from './anchors';

const SAMPLE =
  'Stabilizer codes are defined by an abelian subgroup S of the Pauli group. ' +
  'The code space is the simultaneous +1 eigenspace of every element of S, and its dimension is 2^k.';

function textOf(text: string, a: { start: number | null; end: number | null }): string {
  const idx = new CodePointIndex(text);
  return text.slice(idx.toUnit(a.start!), idx.toUnit(a.end!));
}

describe('CodePointIndex', () => {
  it('converts both ways around astral characters', () => {
    const text = 'a😀b𝔖c';
    const idx = new CodePointIndex(text);
    expect(idx.length).toBe(5);
    expect([0, 1, 2, 3, 4, 5].map((cp) => idx.toUnit(cp))).toEqual([0, 1, 3, 4, 6, 7]);
    expect([0, 1, 3, 4, 6, 7].map((u) => idx.toCp(u))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(codePointLength(text)).toBe(5);
  });
});

describe('makeAnchor', () => {
  it('records the quote, 32 code points of context and code-point offsets', () => {
    const text = '😀'.repeat(40) + 'target' + '𝔖'.repeat(40);
    const a = makeAnchor(text, 40, 46);
    expect(a.quote).toBe('target');
    expect(a.start).toBe(40);
    expect(a.end).toBe(46);
    expect(codePointLength(a.prefix)).toBeLessThanOrEqual(32);
    expect(a.prefix.startsWith('😀')).toBe(true);
    expect(a.suffix.endsWith('𝔖')).toBe(true);
  });

  it('rejects ranges outside the text', () => {
    expect(() => makeAnchor('abc', 2, 9)).toThrow(RangeError);
    expect(() => makeAnchor('abc', 2, 1)).toThrow(RangeError);
  });
});

describe('resolveAnchor', () => {
  it('keeps stored offsets that still hold a unique quote', () => {
    const a = makeAnchor(SAMPLE, 0, 16);
    expect(resolveAnchor(SAMPLE, a)).toEqual(a);
  });

  it('follows the quote when text is inserted before it, astral characters included', () => {
    const before = 'Intro 😀 text. The quoted words live here. End.';
    const from = before.indexOf('The quoted');
    const idx = new CodePointIndex(before);
    const anchor = makeAnchor(before, idx.toCp(from), idx.toCp(from) + 'The quoted words'.length);
    const after = '𝔖𝔖𝔖 more 😀😀 ' + before;
    const resolved = resolveAnchor(after, anchor);
    expect(isOrphaned(resolved)).toBe(false);
    expect(textOf(after, resolved)).toBe('The quoted words');
    expect(resolved.quote).toBe('The quoted words');
  });

  it('matches through changed whitespace and maps back to the original offsets', () => {
    const anchor = {
      quote: 'simultaneous +1 eigenspace of every',
      prefix: '',
      suffix: '',
      start: 3,
      end: 40,
    };
    const text = 'The code space is the simultaneous\n  +1   eigenspace\nof every element.';
    const resolved = resolveAnchor(text, anchor);
    expect(textOf(text, resolved)).toBe('simultaneous\n  +1   eigenspace\nof every');
    expect(resolved.quote).toBe('simultaneous\n  +1   eigenspace\nof every');
  });

  it('disambiguates duplicates by context, then by distance to the stored start', () => {
    const text = 'alpha beta gamma. delta beta epsilon. zeta beta eta.';
    const second = text.indexOf('beta', 20);
    const anchor = makeAnchor(text, second, second + 4);
    const shifted = 'NEW ' + text;
    const resolved = resolveAnchor(shifted, { ...anchor, start: 0, end: 4 });
    expect(resolved.start).toBe(second + 4);
    expect(resolved.suffix.startsWith(' epsilon')).toBe(true);
  });

  it('follows the line the anchor was on when an earlier line is deleted (stale offsets)', () => {
    const text = 'x = 1\nx = 2\nx = 3\n';
    const anchor = makeAnchor(text, 6, 7);
    const after = 'x = 2\nx = 3\n';
    const resolved = resolveAnchor(after, anchor);
    expect(resolved.start).toBe(0);
    expect(resolved.end).toBe(1);
  });

  it('orphans a repeated quote it cannot place, rather than guessing', () => {
    const text = 'foo bar. foo bar.';
    // No stored offsets and identical context: ambiguous.
    expect(isOrphaned(resolveAnchor(text, { quote: 'foo', prefix: '', suffix: '' }))).toBe(true);
  });

  it('copes with thousands of identical occurrences', () => {
    const text = 'ab '.repeat(3000);
    const anchor = makeAnchor(text, 300, 303);
    const t0 = performance.now();
    const resolved = resolveAnchor(text, anchor);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(resolved.start === null || resolved.start === 300).toBe(true);
    const lost = resolveAnchor('x' + text, { ...anchor, start: null, end: null });
    expect(isOrphaned(lost)).toBe(true);
  });

  it('orphans a deleted quote', () => {
    const anchor = makeAnchor(SAMPLE, 0, 16);
    const resolved = resolveAnchor('Something entirely different, with no overlap at all.', anchor);
    expect(isOrphaned(resolved)).toBe(true);
    expect(resolved.quote).toBe(anchor.quote);
  });

  it('re-finds a lightly edited quote and rewrites the quote to the matched text', () => {
    const quote = 'the simultaneous +1 eigenspace of every element of S';
    const start = SAMPLE.indexOf(quote);
    const anchor = makeAnchor(SAMPLE, start, start + quote.length);
    const edited = SAMPLE.replace('every element of S', 'every single element of S');
    const resolved = resolveAnchor(edited, anchor);
    expect(isOrphaned(resolved)).toBe(false);
    expect(textOf(edited, resolved)).toBe(resolved.quote);
    expect(resolved.quote).toContain('simultaneous +1 eigenspace');
    expect(resolved.quote.length).toBeLessThanOrEqual(Math.ceil(quote.length * 1.1));
  });

  it('does not absorb neighbouring text when fuzzy matching', () => {
    const quote = 'the simultaneous +1 eigenspace of every element';
    const text =
      'Intro sentence. the simultaneous +1 eigenspace of each element. And a long tail follows here.';
    const resolved = resolveAnchor(text, {
      quote,
      prefix: '',
      suffix: '',
      start: 16,
      end: 16 + quote.length,
    });
    expect(isOrphaned(resolved)).toBe(false);
    expect(resolved.end! - resolved.start!).toBeLessThanOrEqual(Math.ceil(quote.length * 1.1));
    expect(resolved.quote.startsWith('the simultaneous')).toBe(true);
  });

  it('never fuzzy-matches short quotes', () => {
    expect(
      isOrphaned(resolveAnchor('the cat sat on the mat', { quote: 'the cot', start: 0, end: 7 })),
    ).toBe(true);
    expect(
      isOrphaned(
        resolveAnchor('one two three four', { quote: 'one twp three', start: 0, end: 13 }),
      ),
    ).toBe(false);
    expect(
      isOrphaned(
        resolveAnchor('supercalifragilistic stuff', {
          quote: 'supercalifragilistik',
          start: 0,
          end: 20,
        }),
      ),
    ).toBe(true);
  });

  it('does not match unrelated text', () => {
    const anchor = makeAnchor(SAMPLE, 0, 60);
    const other =
      'Reinforcement learning optimises a policy through trial and error interaction with an environment.';
    expect(isOrphaned(resolveAnchor(other, anchor))).toBe(true);
  });

  it('resolves a 2 kB quote in a 100 kB section quickly', () => {
    const words = Array.from({ length: 20000 }, (_, i) => `w${(i * 7919) % 10007}`);
    const text = words.join(' ');
    const start = 50000;
    const anchor = makeAnchor(text, start, start + 2000);
    const edited = text.slice(0, start + 1000) + 'INSERTED' + text.slice(start + 1000);
    const t0 = performance.now();
    const resolved = resolveAnchor(edited, { ...anchor, start: 10 });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1000);
    if (!isOrphaned(resolved)) expect(textOf(edited, resolved)).toBe(resolved.quote);
    const t1 = performance.now();
    resolveAnchor(`Z${text.slice(0, 60000)}${text.slice(61000)}`, { ...anchor, start: 12 });
    expect(performance.now() - t1).toBeLessThan(1000);
  });

  it('resolves to UTF-16 units for the editor', () => {
    const text = '😀 hello world, again';
    const anchor = makeAnchor(text, 2, 7);
    expect(resolveAnchorUnits(text, anchor)).toEqual({ start: 3, end: 8 });
  });
});

describe('change mapping', () => {
  const range = { start: 10, end: 20 };
  it('shifts for edits before, ignores edits after, grows for edits inside', () => {
    expect(mapRangeThroughChange(range, { from: 0, to: 0, insertedLength: 3 })).toEqual({
      start: 13,
      end: 23,
    });
    expect(mapRangeThroughChange(range, { from: 2, to: 5, insertedLength: 0 })).toEqual({
      start: 7,
      end: 17,
    });
    expect(mapRangeThroughChange(range, { from: 25, to: 25, insertedLength: 4 })).toEqual(range);
    expect(mapRangeThroughChange(range, { from: 14, to: 14, insertedLength: 2 })).toEqual({
      start: 10,
      end: 22,
    });
    expect(mapRangeThroughChange(range, { from: 12, to: 15, insertedLength: 0 })).toEqual({
      start: 10,
      end: 17,
    });
  });

  it('keeps text typed at the edges outside', () => {
    expect(mapRangeThroughChange(range, { from: 10, to: 10, insertedLength: 2 })).toEqual({
      start: 12,
      end: 22,
    });
    expect(mapRangeThroughChange(range, { from: 20, to: 20, insertedLength: 2 })).toEqual(range);
  });

  it('truncates on edge overlap and drops a swallowed range', () => {
    expect(mapRangeThroughChange(range, { from: 8, to: 12, insertedLength: 1 })).toEqual({
      start: 9,
      end: 17,
    });
    expect(mapRangeThroughChange(range, { from: 18, to: 25, insertedLength: 0 })).toEqual({
      start: 10,
      end: 18,
    });
    expect(mapRangeThroughChange(range, { from: 5, to: 25, insertedLength: 3 })).toBeNull();
    expect(mapRangeThroughChange(range, { from: 10, to: 20, insertedLength: 5 })).toBeNull();
  });

  it('diffChange finds the single changed span without splitting surrogates', () => {
    expect(diffChange('abcdef', 'abXYdef')).toEqual({ from: 2, to: 3, insertedLength: 2 });
    expect(diffChange('same', 'same')).toBeNull();
    const change = diffChange('a😀b', 'a😁b')!;
    expect(change).toEqual({ from: 1, to: 3, insertedLength: 2 });
  });

  it('maps an anchor through a change in code points and refreshes its quote', () => {
    const text = '😀 one two three four';
    const anchor = makeAnchor(text, 6, 9);
    const after = '😀 ONE one two three four';
    const mapped = mapAnchorThroughChange(anchor, { from: 2, to: 2, insertedLength: 4 }, after);
    expect(mapped.start).toBe(10);
    expect(mapped.quote).toBe('two');
    const gone = mapAnchorThroughChange(
      anchor,
      { from: 5, to: 10, insertedLength: 0 },
      '😀 on four',
    );
    expect(isOrphaned(gone)).toBe(true);
  });
});

describe('context first, boundaries never', () => {
  const T =
    'Let $x_1$ and $x_2$ be the two inputs of the comparator. The network compares x with y and returns the larger one.';

  it('keeps a sub-word selection on its own occurrence when text is inserted before', () => {
    const a = makeAnchor(T, 5, 6);
    const resolved = resolveAnchor('Note. ' + T, a);
    expect(resolved.start).toBe(11);
    expect(resolved.end).toBe(12);
  });

  it('orphans a context-free anchor whose quote repeats, instead of trusting stale offsets', () => {
    const resolved = resolveAnchor('Note. ' + T, {
      quote: 'x',
      prefix: '',
      suffix: '',
      start: 5,
      end: 6,
    });
    expect(isOrphaned(resolved)).toBe(true);
  });

  it('records up to 32 code points of context on makeAnchor', () => {
    const a = makeAnchor(T, 40, 45);
    expect(a.prefix.length).toBeGreaterThan(0);
    expect(a.suffix.length).toBeGreaterThan(0);
  });

  it('never lands on another occurrence (seeded property test)', () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const pick = <U>(xs: U[]): U => xs[Math.floor(rand() * xs.length)]!;
    const vocab = [
      'x',
      'y',
      'the',
      'a',
      'of',
      'and',
      'node',
      'edge',
      'is',
      'in',
      'with',
      'set',
      'let',
      'if',
    ];
    let orphans = 0;
    let trials = 0;
    for (let round = 0; round < 300; round += 1) {
      const text = Array.from({ length: 150 + Math.floor(rand() * 100) }, () => pick(vocab)).join(
        ' ',
      );
      const start = 80 + Math.floor(rand() * (text.length - 200));
      const words = rand() < 0.5;
      let end: number;
      if (words) {
        end = start;
        for (let w = 0; w < 1 + Math.floor(rand() * 3); w += 1) {
          const next = text.indexOf(' ', end + 1);
          end = next === -1 ? text.length : next;
        }
      } else {
        end = start + 1 + Math.floor(rand() * 4);
      }
      if (end > text.length - 40) continue;
      const anchor = makeAnchor(text, start, end);
      // Edit well outside the 32-character context on either side.
      const insertBefore = rand() < 0.5;
      let edited: string;
      let expected: number;
      if (insertBefore) {
        const at = Math.floor(rand() * (start - 40));
        const ins =
          Array.from({ length: 1 + Math.floor(rand() * 5) }, () => pick(vocab)).join(' ') + ' ';
        edited = text.slice(0, at) + ins + text.slice(at);
        expected = start + ins.length;
      } else {
        const at = end + 40 + Math.floor(rand() * 10);
        edited = text.slice(0, at) + ' extra words here ' + text.slice(at);
        expected = start;
      }
      trials += 1;
      const resolved = resolveAnchor(edited, anchor);
      if (isOrphaned(resolved)) {
        orphans += 1;
        continue;
      }
      expect(resolved.start).toBe(expected);
      expect(resolved.quote).toBe(text.slice(start, end));
    }
    expect(trials).toBeGreaterThan(200);
    expect(orphans / trials).toBeLessThan(0.02);
  });
});

describe('resolver edge cases (review round 1)', () => {
  it('a context cut short by the text edge only agrees with a hit at that edge', () => {
    const a = makeAnchor('foo bar foo', 8, 11);
    expect(a.suffix).toBe('');
    // Text inserted before the last `foo`: it is still the last one.
    expect(resolveAnchor('foo bar baz foo', a).start).toBe(12);
    // Nothing at the end any more: the first `foo` is another occurrence, not this one.
    expect(isOrphaned(resolveAnchor('foo bar baz', a))).toBe(true);
    expect(isOrphaned(resolveAnchor('foo bar baz foo qux', a))).toBe(true);
  });

  it('never re-attaches a short quote to another occurrence after its text was replaced', () => {
    const text =
      'The energy of the system is conserved here. ' +
      'x'.repeat(40) +
      ' But the energy is lost later on.';
    const first = text.indexOf('energy');
    const a = makeAnchor(text, first, first + 6);
    const edited = text.replace('energy', 'power');
    expect(isOrphaned(resolveAnchor(edited, a))).toBe(true);
    // Untouched surroundings still find it.
    expect(resolveAnchor('Intro. ' + text, a).start).toBe(first + 7);
  });

  it('counts context in code points, so astral characters do not look like a text edge', () => {
    const text = '😀'.repeat(40) + 'target' + '𝔖'.repeat(40);
    const a = makeAnchor(text, 40, 46);
    expect(codePointLength(a.prefix)).toBe(32);
    expect(codePointLength(a.suffix)).toBe(32);
    expect(resolveAnchor('NEW ' + text, a).start).toBe(44);
  });

  it('never re-attaches to another occurrence (small vocabulary, deleted quotes)', () => {
    let seed = 777;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const vocab = ['a', 'b', 'c', 'ab', 'bc'];
    let wrong = 0;
    for (let round = 0; round < 400; round += 1) {
      const text = Array.from({ length: 60 }, () => vocab[Math.floor(rand() * vocab.length)]).join(
        ' ',
      );
      const start = 40 + Math.floor(rand() * 60);
      const end = start + 1 + Math.floor(rand() * 5);
      const anchor = makeAnchor(text, start, end);
      // Delete the quote itself (and sometimes a neighbour).
      const edited = text.slice(0, start) + text.slice(end);
      const resolved = resolveAnchor(edited, anchor);
      if (!isOrphaned(resolved)) {
        // Allowed only if the match really carries the stored context on one side.
        const at = resolved.start!;
        const before = edited.slice(Math.max(0, at - anchor.prefix.length), at);
        const after = edited.slice(resolved.end!, resolved.end! + anchor.suffix.length);
        if (before !== anchor.prefix && after !== anchor.suffix) wrong += 1;
      }
    }
    expect(wrong).toBe(0);
  });
});

describe('fuzzy matching never adopts a near-duplicate elsewhere', () => {
  // Varied prose (a deterministic hash per word), so no two stretches share context by accident.
  const words = [
    'lorem',
    'ipsum',
    'dolor',
    'amet',
    'tensor',
    'kernel',
    'gradient',
    'proof',
    'lemma',
    'bound',
    'norm',
    'basis',
    'rank',
    'trace',
    'graph',
    'field',
  ];
  const filler = (n: number, seed: string) => {
    let h = 0;
    for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return (
      Array.from({ length: n * 5 }, () => {
        h = (h * 1664525 + 1013904223) >>> 0;
        return words[(h >>> 8) % words.length];
      }).join(' ') + '.'
    );
  };

  it('a deleted sentence does not move to a similar one 4.8k characters away', () => {
    const a = 'Let $x_1$ be the smallest root of the polynomial $p$.';
    const b = 'Let $x_2$ be the smallest root of the polynomial $q$.';
    const text =
      filler(40, 'intro ') +
      ' ' +
      a +
      ' ' +
      filler(40, 'mid ') +
      ' ' +
      b +
      ' ' +
      filler(10, 'end ');
    const at = text.indexOf(a);
    const anchor = makeAnchor(text, at, at + a.length);
    const edited = text.replace(a + ' ', '');
    expect(isOrphaned(resolveAnchor(edited, anchor))).toBe(true);
  });

  it('the gradient weights/biases variant', () => {
    const a = 'Update the weights using the gradient of the loss with respect to the weights.';
    const b = 'Update the biases using the gradient of the loss with respect to the biases.';
    const text =
      filler(30, 'one ') + ' ' + a + ' ' + filler(60, 'two ') + ' ' + b + ' ' + filler(5, 'three ');
    const at = text.indexOf(a);
    const anchor = makeAnchor(text, at, at + a.length);
    expect(isOrphaned(resolveAnchor(text.replace(a + ' ', ''), anchor))).toBe(true);
  });

  it('still resolves an in-place edit with the context intact', () => {
    const a = 'Let $x_1$ be the smallest root of the polynomial $p$.';
    const text = filler(10, 'intro ') + ' ' + a + ' ' + filler(10, 'tail ');
    const at = text.indexOf(a);
    const anchor = makeAnchor(text, at, at + a.length);
    const edited = text.replace('smallest root', 'smallest real root');
    const resolved = resolveAnchor(edited, anchor);
    expect(isOrphaned(resolved)).toBe(false);
    expect(resolved.quote).toContain('smallest');
    // ...and after text was added before it (offsets stale), the context finds it.
    const shifted = 'New opening paragraph. ' + edited;
    expect(isOrphaned(resolveAnchor(shifted, anchor))).toBe(false);
  });

  it('seeded near-duplicate property: a deleted sentence never resolves to its near-twin', () => {
    let seed = 4242;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const subjects = ['root', 'weight', 'vector', 'matrix', 'operator', 'kernel'];
    const sentence = (k: number, v: string) =>
      `Let the ${subjects[k % subjects.length]} number ${v} be the smallest element of the set used here.`;
    let wrong = 0;
    for (let round = 0; round < 300; round += 1) {
      const a = sentence(Math.floor(rand() * 6), String(Math.floor(rand() * 90) + 10));
      const b = sentence(Math.floor(rand() * 6), String(Math.floor(rand() * 90) + 10));
      if (a === b) continue;
      const text = `${filler(8 + Math.floor(rand() * 5), 'p')} ${a} ${filler(40 + Math.floor(rand() * 20), 'q')} ${b} ${filler(6, 'r')}`;
      const at = text.indexOf(a);
      const anchor = makeAnchor(text, at, at + a.length);
      const edited = text.replace(a + ' ', '');
      const resolved = resolveAnchor(edited, anchor);
      if (
        !isOrphaned(resolved) &&
        resolved.quote.includes('number') &&
        resolved.start! >= edited.indexOf(b) - 5
      ) {
        wrong += 1;
      }
    }
    expect(wrong).toBe(0);
  });
});
