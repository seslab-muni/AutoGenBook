import { toggleMark } from 'prosemirror-commands';
import { redo, undo } from 'prosemirror-history';
import type { Transaction } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';

import { containerSafe, markdownSlice } from './clipboard';
import {
  agrees,
  dump,
  makeDriver,
  meanings,
  meaningsOfSource,
  pressKey,
  setSelection,
  typeText,
} from './core-driver';
import { schema } from './schema';
import { goldenDocuments, rng } from './test-docs';

/**
 * Random editing sessions against an independent oracle (issue #182, phase 5 review): after every
 * accepted step the editor's blocks must be what a parse of the WHOLE resulting source says, the
 * model's parts must join to its text, blocks the edit did not touch keep their bytes, and edits
 * are almost never refused. Documents use blank lines between blocks, or (second mode) often a
 * single newline, `$` and `[@` and `\` everywhere - nothing is skipped.
 */
const BLOCKS = [
  '# Heading one',
  '## Second *level* heading',
  'Setext title\n===',
  'Plain paragraph with **bold** and *em* and _under_ and `code` text.',
  'A protocol $\\Pi$ satisfies **Byzantine Consensus** if $v_i = v_j$ holds [@lamport_1982].',
  'See \\cite{castro_1999} and [@a; @b] for details & more &amp; done.',
  'Escapes: \\*literal\\* 2 \\* 3 and a\\_b and 1\\. x and \\# no.',
  'Line one\nline two of the same paragraph\nline three',
  'Hard break here\\\nnext line',
  'Hard break spaces  \nnext line',
  'A [link text](https://example.com/a_b "Title") and <https://auto.link> and https://bare.example.com/x.',
  'Ref [text][ref] and [ref] and footnote[^1] and ![img](a.png) and <span>raw</span> html.',
  'Strike ~~gone~~ and ***both*** and **bold *nested em* tail** end.',
  'Unicode: naïve café データ 𝒳 😀 é אב nb sp.',
  '- item one\n- item two\n- item three',
  '* star a\n* star b',
  '1. first\n2. second\n3. third',
  '- parent\n  - child a\n  - child b\n- sibling',
  '- item with $x^2$ and [@key]\n- second **bold**',
  '> quote line one\n> quote line two',
  '> - list in quote\n> - b',
  '> **Theorem 1.1**: callout body $x$.',
  '```python\nprint("hi")\n\n    indented\n```',
  '    indented code\n    more',
  '$$\nn_{\\min} = 3f + 1\n$$',
  '| a | b |\n| - | - |\n| 1 | $x$ |',
  '---',
  '<div class="x">\nhello\n</div>',
  '[^1]: A footnote.',
  '[ref]: https://example.com "T"',
  '- [ ] task\n- [x] done',
  'a < b and c > d, 5 * 3 = 15, x_1 + y_2',
];
const TYPED = [
  'x',
  'ab',
  ' ',
  ' q',
  'é',
  '😀',
  ' ',
  '7.',
  '*',
  '_',
  '#',
  '>',
  '-',
  '+',
  '1.',
  '`',
  '[',
  ']',
  '<',
  '&',
  '\\',
  '|',
  '~',
  '=',
  '!',
  '(',
  ')',
  '# ',
  '## ',
  '- ',
  '* ',
  '1. ',
  '> ',
  '``` ',
  '**b**',
  '*e*',
  '_u_',
  '~~s~~',
  '`c`',
  '[l](u)',
  '<b>',
  '&amp;',
  '---',
  '  ',
  '    ',
  '\\*',
  'a_b_c',
  '![',
  '](',
  'http://x.y',
  'www.a.b',
  ':',
  '[^1]',
  '[ref]',
  'x@y.z',
  '$',
  '$x$',
  '$$',
  '$$x$$',
  '[@k]',
  '\\cite{k}',
  '$5',
];
const PASTE = [
  'plain words',
  '**bold** and *em*',
  '# Pasted heading\n\nand para',
  '- a\n- b',
  'two\n\nparas',
  ' lead space',
  '1. x\n2. y',
  '> q',
  '```\ncode\n```',
  '| a |\n|---|\n| b |',
  '<div>html</div>',
  'line1\nline2',
  '$x$ math',
];

function build(next: () => number, mixed: boolean): string {
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
  const pool = [...BLOCKS, ...goldenDocuments.flatMap((doc) => doc.split(/\n{2,}/).slice(0, 6))];
  const count = next() < 0.05 ? 0 : 1 + Math.floor(next() * 6);
  let out = next() < 0.1 ? pick(['\n', '\n\n', '  \n']) : '';
  for (let i = 0; i < count; i += 1) {
    if (i > 0) {
      out += mixed
        ? pick(['\n\n', '\n\n', '\n\n\n', '\n', '\n', '\n \n'])
        : pick(['\n\n', '\n\n', '\n\n\n', '\n \n']);
    }
    out += pick(pool);
  }
  return out + pick(['', '\n', '\n\n', '  \n', '']);
}

interface Totals {
  steps: number;
  refused: number;
}

function session(seed: number, mixed: boolean, steps: number, totals: Totals) {
  const next = rng(seed * 7919 + 13);
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
  const original = build(next, mixed);
  const driver = makeDriver(original);
  const { core } = driver;
  const fail = (what: string, detail = '') => {
    throw new Error(
      `seed ${seed} (${mixed ? 'mixed' : 'blank'} gaps) ${what}\n original ${JSON.stringify(original)}\n now ${JSON.stringify(core.text)}\n ${dump(core.doc)}\n${detail}`,
    );
  };
  expect(core.model.join()).toBe(original);
  for (let step = 0; step < steps; step += 1) {
    const doc = core.doc;
    let a = 1 + Math.floor(next() * Math.max(1, doc.content.size - 1));
    if (next() < 0.35) {
      const ends: number[] = [];
      doc.descendants((node, pos) => {
        if (node.isTextblock) ends.push(pos + 1, pos + 1 + node.content.size);
        return true;
      });
      if (ends.length > 0) a = pick(ends);
    }
    const b = next() < 0.6 ? a : Math.min(doc.content.size, a + Math.floor(next() * 14));
    try {
      setSelection(core, a, b);
    } catch {
      continue;
    }
    const before = core.doc;
    const textBefore = core.text;
    const kept = new Map(core.model.segments.map((segment) => [segment.node, segment]));
    const op = next();
    let results: ({ ok: boolean } | null)[] = [];
    let history = false;
    let description = '';
    const apply = (tr: Transaction) => core.apply(tr);
    try {
      if (op < 0.38) {
        const text = pick(TYPED);
        description = `type ${JSON.stringify(text)}`;
        results = typeText(driver, text);
      } else if (op < 0.54) {
        const forward = op >= 0.48;
        description = forward ? 'Delete' : 'Backspace';
        const key = pressKey(driver, forward ? 'Delete' : 'Backspace');
        results = [key.result];
        const { from, empty } = core.state.selection;
        if (!key.handled && empty) {
          const $from = core.doc.resolve(from);
          if (forward && $from.parentOffset < $from.parent.content.size) {
            results = [apply(core.state.tr.delete(from, from + 1))];
          } else if (!forward && $from.parentOffset > 0) {
            results = [apply(core.state.tr.delete(from - 1, from))];
          }
        }
      } else if (op < 0.64) {
        description = 'Enter';
        results = [pressKey(driver, 'Enter').result];
      } else if (op < 0.68) {
        description = 'Shift-Enter';
        results = [pressKey(driver, 'Enter', { shift: true }).result];
      } else if (op < 0.76) {
        description = 'Tab';
        results = [pressKey(driver, 'Tab', { shift: op >= 0.72 }).result];
      } else if (op < 0.84) {
        const mark = pick(['strong', 'em', 'code'] as const);
        description = `toggle ${mark}`;
        let result: { ok: boolean } | null = null;
        toggleMark(schema.marks[mark]!)(core.state, (tr) => {
          result = apply(tr);
        });
        results = [result];
      } else if (op < 0.89) {
        const text = pick(PASTE);
        description = `paste ${JSON.stringify(text)}`;
        results = [
          apply(
            core.state.tr.replaceSelection(
              containerSafe(markdownSlice(text), core.state.selection.$from),
            ),
          ),
        ];
      } else {
        history = true;
        const redoing = op >= 0.93;
        description = redoing ? 'redo' : 'undo';
        let result: { ok: boolean } | null = null;
        (redoing ? redo : undo)(core.state, (tr) => {
          result = apply(tr);
        });
        results = [result];
      }
    } catch (error) {
      fail(`threw on ${description}`, String((error as Error).stack));
    }
    totals.steps += 1;
    const done = results.filter((r): r is { ok: boolean } => r !== null);
    if (done.some((r) => !r.ok)) {
      totals.refused += 1;
      // A refused edit leaves the draft exactly as it was when it is the only thing the step did.
      if (done.length === 1 && core.text !== textBefore)
        fail(`${description} was refused but changed the source`);
    }
    if (core.doc === before) continue;
    if (core.model.text !== core.model.join())
      fail(`${description}: the model's parts do not join to its text`);
    if (!agrees(core)) {
      fail(
        `${description}: the editor and the source disagree`,
        ` editor ${JSON.stringify(meanings(core.doc))}\n source ${JSON.stringify(meaningsOfSource(core.text))}`,
      );
    }
    // Blocks the step did not touch keep their bytes (a list that had to take another marker, and indented code that had to be fenced, excepted).
    for (const segment of core.model.segments) {
      const old = kept.get(segment.node);
      if (!old || old.src === segment.src || history) continue;
      const list = /^ {0,3}([-+*]|\d{1,9}[.)])[ \t\r\n]/.test(old.src);
      // (Indented code next to a list is written fenced when it would otherwise be read as part of it.)
      const code = /^ {4}/.test(old.src) && /^(`{3,}|~{3,})/.test(segment.src);
      if (!list && !code)
        fail(
          `${description}: an untouched block was rewritten`,
          ` ${JSON.stringify(old.src)} -> ${JSON.stringify(segment.src)}`,
        );
    }
  }
}

describe('random editing sessions', () => {
  for (const mixed of [false, true]) {
    it(`${mixed ? 'single newlines between blocks, $ [@ \\ everywhere' : 'blank lines between blocks'}: the editor and the whole source always agree, refusals are rare`, () => {
      const totals: Totals = { steps: 0, refused: 0 };
      for (let seed = 1; seed <= 220; seed += 1) session(seed, mixed, 26, totals);
      expect(totals.steps).toBeGreaterThan(4000);
      expect(totals.refused / totals.steps).toBeLessThan(0.006);
    }, 180000);
  }
});
