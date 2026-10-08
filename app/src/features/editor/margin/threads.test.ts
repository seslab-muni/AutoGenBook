import { describe, expect, it } from 'vitest';

import { filterThreads, hasKind, isClosed, isThreadClosed } from './threads';
import { makeComment, makeReview, makeSuggestion, makeThread } from './test-helpers';

describe("thread filters with the copilot's rows", () => {
  const comment = makeThread(makeComment({ id: 'c' }));
  const review = makeThread(makeReview({ id: 'r' }));
  const pending = makeThread(makeSuggestion({ id: 's-pending', status: 'pending' }));
  const accepted = makeThread(makeSuggestion({ id: 's-accepted', status: 'accepted' }));
  const rejected = makeThread(makeSuggestion({ id: 's-rejected', status: 'rejected' }));
  const failed = makeThread(makeSuggestion({ id: 's-failed', status: 'failed' }));
  const cancelled = makeThread(makeSuggestion({ id: 's-cancelled', status: 'cancelled' }));
  const all = [comment, review, pending, accepted, rejected, failed, cancelled];

  it('hides an accepted or rejected suggestion with the resolved ones, but not a failed or cancelled one', () => {
    expect(filterThreads(all, 'all', false).map((t) => t.id)).toEqual([
      'c',
      'r',
      's-pending',
      's-failed',
      's-cancelled',
    ]);
    expect(filterThreads(all, 'all', true)).toHaveLength(all.length);
    expect(isClosed(failed)).toBe(false);
    expect(isClosed(cancelled)).toBe(false);
    expect(isClosed(accepted)).toBe(true);
    expect(isClosed(rejected)).toBe(true);
  });

  it('keeps a dismissed review issue with the resolved ones', () => {
    const dismissed = makeThread(makeReview({ id: 'd', status: 'resolved' }));
    expect(filterThreads([dismissed], 'all', false)).toEqual([]);
    expect(filterThreads([dismissed], 'review', true)).toHaveLength(1);
  });

  it('puts a comment thread that holds a suggestion under the Suggestions filter too', () => {
    const root = makeComment({ id: 'prompting' });
    const inThread = makeThread(root, {
      replies: [
        makeSuggestion({ id: 'answer', status: 'pending', threadId: root.id, parentId: root.id }),
      ],
    });
    expect(hasKind(inThread, 'suggestion')).toBe(true);
    expect(hasKind(inThread, 'comment')).toBe(true);
    expect(hasKind(inThread, 'review')).toBe(false);
    expect(filterThreads([inThread], 'suggestion', false)).toHaveLength(1);
    expect(filterThreads([inThread], 'comment', false)).toHaveLength(1);
    expect(filterThreads([inThread], 'review', false)).toHaveLength(0);
  });

  it('keeps a resolved comment thread visible while a suggestion in it is still waiting', () => {
    const root = makeComment({ id: 'p2', status: 'resolved' });
    const waiting = makeThread(root, {
      replies: [
        makeSuggestion({ id: 'a2', status: 'running', threadId: root.id, parentId: root.id }),
      ],
    });
    expect(isThreadClosed(waiting)).toBe(false);
    expect(filterThreads([waiting], 'all', false)).toHaveLength(1);
    const settled = makeThread(root, {
      replies: [
        makeSuggestion({ id: 'a3', status: 'accepted', threadId: root.id, parentId: root.id }),
      ],
    });
    expect(isThreadClosed(settled)).toBe(true);
  });
});
