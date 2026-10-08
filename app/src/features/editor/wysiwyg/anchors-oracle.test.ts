import { toggleMark } from 'prosemirror-commands';
import { undo } from 'prosemirror-history';
import { describe, expect, it } from 'vitest';

import { mapRangeThroughChange, type TextChange } from '@/features/editor/lib/anchors';

import { containerSafe, markdownSlice } from './clipboard';
import { makeDriver, pressKey, setSelection, typeText } from './core-driver';
import { mapTracked, trackedFrom } from './editor-highlights';
import { schema } from './schema';
import { rng } from './test-docs';

/**
 * Anchors follow an edit like they follow one in the Source view: through its separate hunks, so
 * text the edit did not touch keeps its anchor even when the editor writes a whole block again. The
 * oracle is a plain character-level longest-common-subsequence diff of the source before and after.
 */
function hunksOf(a: string, b: string, insertFirst = true): TextChange[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: TextChange[] = [];
  let current: TextChange | null = null;
  const flush = () => {
    if (current) out.push(current);
    current = null;
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i += 1;
      j += 1;
    } else if (
      j < m &&
      (i === n ||
        (insertFirst ? dp[i]![j + 1]! >= dp[i + 1]![j]! : dp[i]![j + 1]! > dp[i + 1]![j]!))
    ) {
      current ??= { from: i, to: i, insertedLength: 0 };
      current.insertedLength += 1;
      j += 1;
    } else {
      current ??= { from: i, to: i, insertedLength: 0 };
      current.to = i + 1;
      i += 1;
    }
  }
  flush();
  return out;
}

const BLOCKS = [
  'Plain paragraph with **bold words here** and *em text* and `code` in the middle of a sentence.',
  'A protocol $\\Pi$ satisfies **Byzantine Consensus** if for all executions $v_i = v_j$ holds [@lamport_1982] and more.',
  'Entities &amp; escapes \\*literal\\* stay and _under emphasis_ too, with a [link text](https://example.com) inside.',
  '- item one is here\n- item two **bold** there\n- item three',
  '1. first step now\n2. second step then',
  '> quoted line one\n> quoted line two',
  '# Heading text here',
  'Unicode naïve café データ 𝒳 😀 and é combining with more words.',
  'Line one of para\nline two of para\nline three',
];

describe('anchors through edits', () => {
  it('end where the Source view would put them, edit after edit (1500 documents)', () => {
    let checks = 0;
    let disagree = 0;
    const samples: string[] = [];
    for (let seed = 1; seed <= 1500; seed += 1) {
      const next = rng(seed * 31 + 7);
      const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
      const parts: string[] = [];
      for (let i = 0, n = 2 + Math.floor(next() * 3); i < n; i += 1) parts.push(pick(BLOCKS));
      const original = parts.join(pick(['\n\n', '\n\n', '\n']));
      const driver = makeDriver(original);
      const { core } = driver;
      let tracked = trackedFrom(
        Array.from({ length: 6 }, (_, k) => {
          const start = Math.floor(next() * (original.length - 2));
          const end = Math.min(original.length, start + 1 + Math.floor(next() * (k < 4 ? 14 : 80)));
          return { id: `a${k}`, kind: 'comment', start, end };
        }),
        original.length,
      );
      for (let step = 0; step < 12; step += 1) {
        const doc = core.doc;
        const a = 1 + Math.floor(next() * (doc.content.size - 1));
        const b = next() < 0.55 ? a : Math.min(doc.content.size, a + Math.floor(next() * 10));
        try {
          setSelection(core, a, b);
        } catch {
          continue;
        }
        const before = core.text;
        const prior = tracked;
        const op = next();
        const collect = (result: ReturnType<typeof core.apply> | null) => {
          if (result?.ok && result.docChanged) tracked = mapTracked(tracked, result.changes);
        };
        if (op < 0.4) {
          for (const result of typeText(driver, pick(['x', 'word ', ' ', 'é', '😀', '*', 'ab']))) {
            collect(result);
          }
        } else if (op < 0.55) {
          collect(pressKey(driver, 'Backspace').result);
        } else if (op < 0.65) {
          collect(pressKey(driver, 'Enter').result);
        } else if (op < 0.85) {
          toggleMark(schema.marks[pick(['strong', 'em', 'code'])]!)(core.state, (tr) =>
            collect(core.apply(tr)),
          );
        } else if (op < 0.92) {
          const slice = containerSafe(
            markdownSlice(pick(['plain words', '**b** x', 'two\n\nparas'])),
            core.state.selection.$from,
          );
          collect(core.apply(core.state.tr.replaceSelection(slice)));
        } else {
          undo(core.state, (tr) => collect(core.apply(tr)));
        }
        const after = core.text;
        if (after === before) continue;
        // (Where a diff can place an insertion in more than one equal way - the text typed repeats
        // letters that are there - either placement is the Source view's: the editor's own is exact.)
        const oracles = [hunksOf(before, after), hunksOf(before, after, false)];
        prior.forEach((old, k) => {
          if (old.deleted) return;
          checks += 1;
          const now = tracked[k]!;
          const expectations = oracles.map((hunks) => {
            let expected: { start: number; end: number } | null = {
              start: old.start,
              end: old.end,
            };
            for (let h = hunks.length - 1; h >= 0 && expected; h -= 1) {
              expected = mapRangeThroughChange(expected, hunks[h]!);
            }
            return expected;
          });
          const expected = expectations[0] ?? null;
          const agree = expectations.some((e) =>
            e ? !now.deleted && now.start === e.start && now.end === e.end : now.deleted,
          );
          if (!agree) {
            disagree += 1;
            if (samples.length < 5) {
              samples.push(
                `seed ${seed}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}; anchor ${JSON.stringify(before.slice(old.start, old.end))} is ${now.deleted ? 'orphaned' : JSON.stringify(after.slice(now.start, now.end))}, the Source view keeps ${expected ? JSON.stringify(after.slice(expected.start, expected.end)) : 'nothing'}`,
              );
            }
          }
        });
      }
    }
    expect(checks).toBeGreaterThan(8000);
    // (Where a typed character repeats one that is already there, the position of the insertion is
    // ambiguous: a diff and the editor may place it a character apart. Nothing else may differ.)
    expect(disagree / checks, samples.join('\n')).toBeLessThan(0.004);
  }, 180000);

  it('an anchor over a word keeps the word when the word gets bold, and does not grow over the markers', () => {
    const driver = makeDriver('Say hello world now\n');
    const { core } = driver;
    const start = core.text.indexOf('hello world');
    let tracked = trackedFrom(
      [{ id: 'a', kind: 'comment', start, end: start + 11 }],
      core.text.length,
    );
    setSelection(
      core,
      core.model.srcToPos(start + 6, 'start'),
      core.model.srcToPos(start + 11, 'end'),
    );
    toggleMark(schema.marks['strong']!)(core.state, (tr) => {
      const result = core.apply(tr);
      if (result.ok) tracked = mapTracked(tracked, result.changes);
    });
    expect(core.text).toBe('Say hello **world** now\n');
    const range = tracked[0]!;
    // As in Source: the opening markers are typed inside the anchor, the closing ones at its edge, outside.
    expect(core.text.slice(range.start, range.end)).toBe('hello **world');
  });

  it('an entity normalised far away does not delete the anchors in between', () => {
    const driver = makeDriver(
      'A &amp; B and a long middle part of the paragraph with words and more words here.\n',
    );
    const { core } = driver;
    const middle = core.text.indexOf('long middle part');
    let tracked = trackedFrom(
      [{ id: 'm', kind: 'comment', start: middle, end: middle + 16 }],
      core.text.length,
    );
    setSelection(core, core.model.srcToPos(core.text.length - 3, 'start'));
    for (const result of typeText(driver, '!')) {
      if (result.ok) tracked = mapTracked(tracked, result.changes);
    }
    expect(tracked[0]!.deleted).toBe(false);
    expect(core.text.slice(tracked[0]!.start, tracked[0]!.end)).toBe('long middle part');
  });
});
