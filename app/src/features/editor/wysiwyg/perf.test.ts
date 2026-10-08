import { describe, expect, it } from 'vitest';

import { makeDriver, setSelection, typeText } from './core-driver';

/**
 * Typing in a huge block costs a keystroke, not a parse of the block (issue #182, phase 5 review):
 * a 60 kB paragraph used to cost about 70 ms per key and keep a copy of itself per key, a list of
 * 600 items 110 ms. The limits are generous (CI machines differ); the real numbers are about 1 ms.
 */
const UNIT =
  'consensus protocol quorum **replica** byzantine $x_i$ fault leader view change [@k1] message digest';

function document(kind: 'paragraph' | 'soft breaks' | 'list'): string {
  const separator = kind === 'paragraph' ? ' ' : kind === 'soft breaks' ? '\n' : '\n- ';
  let text = kind === 'list' ? '- ' : '';
  while (text.length < 60 * 1024) text += UNIT + separator;
  return text.trimEnd().replace(/\n-$/, '');
}

interface ModelInternals {
  recent: unknown[];
  recentBytes: number;
  windows: unknown[];
}

describe('typing in a 60 kB block', () => {
  for (const kind of ['paragraph', 'soft breaks', 'list'] as const) {
    it(`${kind}: a keystroke costs little and the model's memory does not grow with the keys`, () => {
      const driver = makeDriver(document(kind));
      const { core } = driver;
      setSelection(core, Math.floor(core.doc.content.size / 2));
      const times: number[] = [];
      let memoryAt300 = 0;
      for (let i = 0; i < 700; i += 1) {
        const started = performance.now();
        const [result] = typeText(driver, i % 9 === 8 ? ' ' : 'a');
        times.push(performance.now() - started);
        expect(result!.ok).toBe(true);
        if (i === 299) memoryAt300 = (core.model as unknown as ModelInternals).recentBytes;
      }
      const sorted = [...times].sort((a, b) => a - b);
      const median = sorted[350]!;
      const slow = sorted[665]!;
      expect(median, `median ${median.toFixed(1)} ms`).toBeLessThan(15);
      expect(slow, `95th percentile ${slow.toFixed(1)} ms`).toBeLessThan(60);
      // What is kept for an exact undo is bounded by size, not by the number of keys.
      const internals = core.model as unknown as ModelInternals;
      expect(internals.recentBytes).toBeLessThan(8_000_000);
      expect(internals.recentBytes).toBeLessThan(Math.max(memoryAt300, 1) * 1.5 + 100_000);
      expect(core.model.join()).toBe(core.text);
    }, 60000);
  }
});
