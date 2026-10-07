import { describe, expect, it } from 'vitest';

import { characterCount, wordCount } from './word-count';

describe('wordCount', () => {
  it('counts whitespace-delimited words', () => {
    expect(wordCount('  two   words\nhere ')).toBe(3);
    expect(wordCount('   ')).toBe(0);
  });
});

describe('characterCount', () => {
  it('counts code points, so astral characters count once', () => {
    expect(characterCount('abc')).toBe(3);
    expect(characterCount('a𝔖b')).toBe(3);
    expect(characterCount('')).toBe(0);
  });
});
