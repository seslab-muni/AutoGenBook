import { describe, expect, it } from 'vitest';

import { ApiError } from '@/api/client';
import {
  describeAcceptError,
  describeStartError,
  describeSuggestionFailure,
  isContentConflict,
} from './copilot-errors';

function apiError(status: number, code: string | null, detail = 'server words') {
  return new ApiError({
    status,
    url: '/x',
    problem: { type: 'about:blank', title: 'Conflict', status, instance: '/x', detail, code },
  });
}

describe('describeStartError', () => {
  it.each([
    ['section_empty', /nothing to revise/i],
    ['node_generating', /run is generating/i],
    ['anchor_orphaned', /select it again/i],
    ['revision_in_progress', /already running/i],
    ['llm_key_required', /API key/],
    ['llm_not_configured', /No LLM key is configured/],
    ['too_many_revisions', /several revisions running/],
    ['section_too_large', /select a passage/i],
  ])('says what %s means in words, never the status code', (code, pattern) => {
    const failure = describeStartError(apiError(code === 'too_many_revisions' ? 429 : 409, code));
    expect(failure.message).toMatch(pattern);
    expect(failure.message).not.toMatch(/\b(409|429)\b/);
    expect(failure.code).toBe(code);
  });

  it("shows the server's own reason for a rewrite refusal it has no text for", () => {
    expect(
      describeStartError(apiError(409, null, 'No successful prior run to resume from')),
    ).toEqual({
      message: 'No successful prior run to resume from',
      code: null,
    });
  });

  it('falls back to a plain network hint', () => {
    expect(describeStartError(new TypeError('Failed to fetch')).message).toBe('Failed to fetch');
  });
});

describe('describeSuggestionFailure', () => {
  it.each([
    ['llm_auth', /rejected the API key/],
    ['llm_rate_limited', /rate limiting/],
    ['llm_timeout', /took too long/],
    ['llm_error', /returned an error/],
    ['llm_config', /not configured/],
    ['unusable_output', /could not be read/],
    ['anchor_orphaned', /changed/],
    ['timeout', /too long/],
    ['interrupted', /interrupted/],
    ['internal', /went wrong/],
  ])('maps %s', (code, pattern) => {
    expect(describeSuggestionFailure(code, '')).toMatch(pattern);
  });

  it("appends the engine's explanation to a revision_failed, and falls back to the server text", () => {
    expect(describeSuggestionFailure('revision_failed', 'It echoed the context.')).toMatch(
      /could not be applied\. It echoed the context\./,
    );
    expect(describeSuggestionFailure('brand_new_code', 'Fixed user-facing text')).toBe(
      'Fixed user-facing text',
    );
    expect(describeSuggestionFailure(null, '')).toBe('The revision failed.');
  });
});

describe('describeAcceptError', () => {
  it('explains stale and content_conflict instead of toasting a generic failure', () => {
    expect(describeAcceptError(apiError(409, 'stale')).message).toMatch(
      /can no longer be applied cleanly/,
    );
    expect(describeAcceptError(apiError(409, 'content_conflict')).message).toMatch(
      /section changed since you last saw it/,
    );
    expect(describeAcceptError(apiError(409, 'not_pending')).message).toMatch(/already/);
    expect(describeAcceptError(apiError(409, 'run_active')).message).toMatch(/full run/);
  });

  it('knows a content conflict', () => {
    expect(isContentConflict(apiError(409, 'content_conflict'))).toBe(true);
    expect(isContentConflict(apiError(409, 'stale'))).toBe(false);
    expect(isContentConflict(new Error('x'))).toBe(false);
  });
});
