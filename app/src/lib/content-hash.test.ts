import { describe, expect, it } from 'vitest';

import { sha256Hex } from './content-hash';

describe('sha256Hex', () => {
  it('hashes the UTF-8 bytes of the text, as lowercase hex', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    // Non-ASCII and astral text hash by their UTF-8 bytes, as the server does.
    expect(await sha256Hex('𝒫é')).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex('𝒫é')).not.toBe(await sha256Hex('Pe'));
  });
});
