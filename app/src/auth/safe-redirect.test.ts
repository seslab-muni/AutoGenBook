import { describe, expect, it } from 'vitest';

import { getSafeRedirectTarget } from './safe-redirect';

describe('getSafeRedirectTarget', () => {
  it('returns the target unchanged when it is a single-leading-slash relative path', () => {
    expect(getSafeRedirectTarget('/p/some-project?node=abc')).toBe('/p/some-project?node=abc');
    expect(getSafeRedirectTarget('/')).toBe('/');
  });

  it('falls back to / when there is no redirect', () => {
    expect(getSafeRedirectTarget(undefined)).toBe('/');
  });

  it('falls back to / for an absolute URL (not same-origin-relative)', () => {
    expect(getSafeRedirectTarget('https://evil.example.com/phish')).toBe('/');
    expect(getSafeRedirectTarget('evil.example.com')).toBe('/');
  });

  it('falls back to / for a protocol-relative URL starting with //', () => {
    expect(getSafeRedirectTarget('//evil.example.com')).toBe('/');
  });

  it('falls back to / for a backslash-based scheme-relative URL', () => {
    expect(getSafeRedirectTarget('/\\evil.example.com')).toBe('/');
  });
});
