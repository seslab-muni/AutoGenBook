import { describe, expect, it } from 'vitest';

import { CHIP_PARAMS, mentionsCopilot } from './use-copilot';

describe('mentionsCopilot', () => {
  it.each([
    ['@copilot shorten this', true],
    ['Please @copilot add a proof', true],
    ['(@Copilot, please)', true],
    ['ping @COPILOT', true],
    ['copilot without the at sign', false],
    ['email me at x@copilot.example', false],
    ['@copilots plural', false],
    ['a@copilot', false],
  ])('%s -> %s', (text, expected) => {
    expect(mentionsCopilot(text)).toBe(expected);
  });
});

describe('quick chips', () => {
  it('each sends exactly one typed parameter', () => {
    expect(CHIP_PARAMS).toEqual({
      'Add proof': { moreProofs: true },
      'More rigorous': { moreRigorous: true },
      Shorter: { shorter: true },
      Cite: { citeSources: true },
    });
  });
});
