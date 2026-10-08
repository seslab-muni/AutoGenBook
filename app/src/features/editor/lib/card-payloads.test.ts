import { describe, expect, it } from 'vitest';

import {
  parseReviewSummary,
  reviewPayload,
  reviewTypeLabel,
  suggestionPayload,
} from './card-payloads';

describe('reviewPayload', () => {
  it('reads the issue fields and folds an unknown severity into major', () => {
    const payload = reviewPayload({
      payload: {
        type: 'consistency:term',
        severity: 'critical',
        requiredFix: 'Pick one name.',
        replaceFrom: 'decide',
        replaceTo: 'output',
        source: 'consistency',
        outdated: true,
      },
    });
    expect(payload).toEqual({
      type: 'consistency:term',
      severity: 'major',
      requiredFix: 'Pick one name.',
      replaceFrom: 'decide',
      replaceTo: 'output',
      source: 'consistency',
      outdated: true,
    });
  });

  it('survives an empty payload', () => {
    expect(reviewPayload({ payload: {} })).toMatchObject({
      type: 'issue',
      severity: 'major',
      requiredFix: '',
      replaceFrom: '',
      replaceTo: '',
      source: 'reviewer',
      outdated: false,
    });
  });

  it('labels types for display', () => {
    expect(reviewTypeLabel('coverage')).toBe('Coverage');
    expect(reviewTypeLabel('consistency:term')).toBe('Consistency: term');
    expect(reviewTypeLabel('missing_proof')).toBe('Missing proof');
  });
});

describe('parseReviewSummary', () => {
  it('returns null for a section that was never reviewed', () => {
    expect(parseReviewSummary(null)).toBeNull();
    expect(parseReviewSummary(undefined)).toBeNull();
    expect(parseReviewSummary([])).toBeNull();
  });

  it('reads the verdict, the counts and both lists', () => {
    expect(
      parseReviewSummary({
        okToKeep: false,
        issueCount: 3,
        suggestedEdits: ['a', 7, 'b'],
        retrievalQueries: ['q'],
        runId: null,
        reviewedAt: '2026-08-16T09:30:00Z',
      }),
    ).toEqual({
      okToKeep: false,
      issueCount: 3,
      suggestedEdits: ['a', 'b'],
      retrievalQueries: ['q'],
      reviewedAt: '2026-08-16T09:30:00Z',
    });
  });
});

describe('suggestionPayload', () => {
  it('reads a pending suggestion, dropping malformed hunks', () => {
    const payload = suggestionPayload({
      payload: {
        verb: 'revise',
        scope: 'range',
        instruction: 'Add a proof.',
        params: { moreProofs: true, fixIssueIds: ['i1', 3] },
        threadId: 't1',
        baseContentHash: 'abc',
        originalMarkdown: 'old',
        replacementMarkdown: 'new',
        hunks: [
          { start: 0, end: 3, removed: 'old', added: 'new' },
          { start: 'x', end: 1 },
          { start: 5, end: 2, removed: '', added: '' },
        ],
        summary: 'Rewrote it.',
        changesMade: ['one'],
        warnings: ['w'],
        droppedCitations: ['k'],
      },
    });
    expect(payload.scope).toBe('range');
    expect(payload.params.moreProofs).toBe(true);
    expect(payload.params.fixIssueIds).toEqual(['i1']);
    expect(payload.hunks).toEqual([{ start: 0, end: 3, removed: 'old', added: 'new' }]);
    expect(payload.threadId).toBe('t1');
    expect(payload.error).toBeNull();
  });

  it('reads the error of a failed one and defaults everything else', () => {
    const payload = suggestionPayload({
      payload: { error: { code: 'llm_timeout', message: 'slow' } },
    });
    expect(payload.error).toEqual({ code: 'llm_timeout', message: 'slow' });
    expect(payload.scope).toBe('section');
    expect(payload.originalMarkdown).toBeNull();
    expect(payload.hunks).toEqual([]);
  });
});
