import { describe, expect, it } from 'vitest';

import { mentionsCopilot } from './mentions';
import { CHIP_PARAMS } from './use-copilot';

describe('mentionsCopilot', () => {
  it.each([
    ['@copilot shorten this', true],
    ['Please @copilot add a proof', true],
    ['(@Copilot, please)', true],
    ['ping @COPILOT', true],
    ['thanks, @copilot.', true],
    ['first line\n@copilot on the second', true],
    ['copilot without the at sign', false],
    ['email me at x@copilot.example', false],
    ['write to help@copilot.com', false],
    ['@copilot.com is a site', false],
    ['@copilots plural', false],
    ['a@copilot', false],
    // Code is not a prompt: an inline span, a fenced block, an unterminated fence.
    ['use the `@copilot` handle', false],
    ['```\n@copilot please\n```', false],
    ['~~~\n@copilot please', false],
    // A quoted line is somebody else's text.
    ['> @copilot said so earlier\nI agree', false],
    ['> quoting\n@copilot but now me', true],
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
