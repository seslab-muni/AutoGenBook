import { afterEach, describe, expect, it, vi } from 'vitest';

import { isWriteEditingEnabled } from './write-editing';

afterEach(() => vi.unstubAllEnvs());

describe('isWriteEditingEnabled', () => {
  it('is on unless the switch says otherwise', () => {
    vi.stubEnv('VITE_WRITE_EDITING', undefined as unknown as string);
    expect(isWriteEditingEnabled()).toBe(true);
    for (const on of ['1', 'true', 'on', 'yes', '', 'anything']) {
      vi.stubEnv('VITE_WRITE_EDITING', on);
      expect(isWriteEditingEnabled(), on).toBe(true);
    }
  });

  it('is off for 0, false, off and no, however written', () => {
    for (const off of ['0', 'false', 'FALSE', 'off', ' Off ', 'no']) {
      vi.stubEnv('VITE_WRITE_EDITING', off);
      expect(isWriteEditingEnabled(), off).toBe(false);
    }
  });
});
