import { describe, expect, it } from 'vitest';

import { diffHunks } from './hunks';
import { agrees, makeDriver, pressKey, setSelection, typeText, atSource } from './core-driver';

const apply = (text: string, hunks: ReturnType<typeof diffHunks>, after: string) => {
  // Rebuild `after` from `before` and the hunks: what is kept and what is inserted, in order.
  let out = '';
  let at = 0;
  let inserted = 0;
  for (const hunk of hunks) {
    out += text.slice(at, hunk.from);
    // The inserted text is the next stretch of `after` of that length.
    const position = out.length;
    out += after.slice(position, position + hunk.insertedLength);
    at = hunk.to;
    inserted += hunk.insertedLength;
  }
  void inserted;
  return out + text.slice(at);
};

describe('the hunks of a source change', () => {
  it('are separate where the text between them is unchanged', () => {
    const before = 'one two three four five';
    const after = 'ONE two three FOUR five';
    const hunks = diffHunks(before, after);
    expect(hunks.length).toBe(2);
    expect(apply(before, hunks, after)).toBe(after);
    expect(hunks[0]!.to).toBeLessThanOrEqual(hunks[1]!.from);
  });

  it('are none for equal texts, one for one stretch, and still rebuild the text for very different ones', () => {
    expect(diffHunks('same', 'same')).toEqual([]);
    expect(diffHunks('ab', 'aXb')).toEqual([{ from: 1, to: 1, insertedLength: 1 }]);
    const a = Array.from({ length: 4000 }, (_, i) => `line ${i} of the text\n`).join('');
    const b = a
      .replace('line 1200 of', 'line 1200 changed of')
      .replace('line 3000 of', 'line three thousand of');
    const hunks = diffHunks(a, b);
    expect(hunks.length).toBe(2);
    expect(apply(a, hunks, b)).toBe(b);
    // Past any budget it is one coarse hunk, never a wrong one.
    const c = 'x'.repeat(30000);
    const d = 'y'.repeat(30000);
    const coarse = diffHunks(c, d);
    expect(apply(c, coarse, d)).toBe(d);
  });
});

describe('a list that has to take another marker', () => {
  it('has only its marker characters rewritten, nothing else of it', () => {
    const text = '- one **bold**\n  - nested\n- two $x$\n\nTail';
    const driver = makeDriver(text);
    const { core } = driver;
    // A list typed under it with the same marker: the new list takes another marker, this one is left alone.
    setSelection(core, atSource(core, text.indexOf('Tail')));
    typeText(driver, '- ');
    expect(agrees(core)).toBe(true);
    expect(core.text.startsWith('- one **bold**\n  - nested\n- two $x$')).toBe(true);
  });

  it('an untouched list next to a new one with the same marker changes by its marker characters alone', () => {
    const text = 'Intro\n\n* a *em* and `code`\n  * nested\n* b $x$\n';
    const driver = makeDriver(text);
    const { core } = driver;
    setSelection(core, atSource(core, text.indexOf('Intro') + 5));
    pressKey(driver, 'Enter');
    typeText(driver, '* new');
    expect(agrees(core)).toBe(true);
    // The new list keeps the marker typed; the list that was there takes another one - and only the
    // marker characters of its items change (the nested list has its own and keeps it).
    expect(core.text).toBe('Intro\n\n* new\n\n- a *em* and `code`\n  * nested\n- b $x$\n');
  });
});

describe('the memory kept for an exact undo', () => {
  it('is bounded by size however long the typing', () => {
    let text = '';
    while (text.length < 200_000) text += 'word '.repeat(40) + '\n\n';
    const driver = makeDriver(text);
    const { core } = driver;
    setSelection(core, Math.floor(core.doc.content.size / 2));
    for (let i = 0; i < 300; i += 1) {
      // (A character the fast path cannot take, so every key writes the block again.)
      typeText(driver, i % 2 ? '.' : 'a');
    }
    const model = core.model as unknown as { recentBytes: number; recent: unknown[] };
    expect(model.recentBytes).toBeLessThan(8_000_000);
    expect(model.recent.length).toBeLessThanOrEqual(1024);
  }, 60000);
});
