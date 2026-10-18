import { vi } from 'vitest';

import type { Comment } from '@/api/types';
import { toServerAnchor } from '@/features/editor/lib/server-anchor';
import type { MarginCardContext } from './card-registry';
import type { MarginThread } from './threads';

let counter = 0;

/** A comment row as the API would return it, for component tests. */
export function makeComment(overrides: Partial<Comment> = {}): Comment {
  counter += 1;
  const id = overrides.id ?? `c-${counter}`;
  return {
    id,
    projectId: 'book-reinforcement-learning',
    nodeId: 'rl-sec-1-1',
    kind: 'comment',
    authorId: 'user-mock-1',
    authorName: 'Ada Researcher',
    anchor: null,
    status: 'open',
    threadId: overrides.threadId ?? id,
    parentId: null,
    bodyMarkdown: 'A comment',
    payload: {},
    createdAt: new Date(Date.now() - 5 * 60_000 + counter).toISOString(),
    updatedAt: new Date().toISOString(),
    editedAt: null,
    ...overrides,
  };
}

/** A thread view-model as `useSectionComments` builds it. */
export function makeThread(
  root: Comment,
  options: {
    replies?: Comment[];
    range?: { start: number; end: number } | null;
    quote?: string;
  } = {},
): MarginThread {
  const sectionLevel = root.anchor === null;
  const range = options.range ?? null;
  return {
    id: root.id,
    kind: root.kind,
    root,
    replies: options.replies ?? [],
    status: root.status,
    range,
    orphaned: !sectionLevel && range === null,
    pending: false,
    sectionLevel,
    quote: options.quote ?? root.anchor?.quote ?? '',
  };
}

/** A card context for tests: inert callbacks, overridable. */
export function makeContext(overrides: Partial<MarginCardContext> = {}): MarginCardContext {
  return {
    projectId: 'book-reinforcement-learning',
    nodeId: 'rl-sec-1-1',
    currentUserId: 'user-mock-1',
    restoreEditorFocus: vi.fn(),
    applyServerContent: vi.fn(),
    hasUnsavedEdits: () => false,
    flushEdits: () => Promise.resolve(),
    holdSaving: () => Promise.resolve(() => {}),
    sectionNumber: '1.1',
    serverAnchor: toServerAnchor,
    editBlockedReason: null,
    revisable: true,
    rewriteBlock: null,
    knownIds: () => new Set<string>(),
    ...overrides,
  };
}

/** A reviewer issue row (`kind=review`) as the graph import writes it. */
export function makeReview(
  overrides: Partial<Comment> = {},
  payload: Record<string, unknown> = {},
): Comment {
  return makeComment({
    kind: 'review',
    authorId: null,
    authorName: null,
    bodyMarkdown: 'Termination is stated but never argued for.',
    anchor: { quote: 'the quoted words', prefix: '', suffix: '', start: 4, end: 20 },
    payload: {
      issueKey: 'k1',
      type: 'coverage',
      severity: 'major',
      requiredFix: 'Add a short argument.',
      replaceFrom: '',
      replaceTo: '',
      quote: 'the quoted words',
      okToKeep: false,
      source: 'reviewer',
      runId: null,
      outdated: false,
      ...payload,
    },
    ...overrides,
  });
}

/** A suggestion row as the revision service writes it. */
export function makeSuggestion(
  overrides: Partial<Comment> = {},
  payload: Record<string, unknown> = {},
): Comment {
  return makeComment({
    kind: 'suggestion',
    authorId: 'user-mock-1',
    authorName: 'Ada Researcher',
    bodyMarkdown: '',
    anchor: null,
    status: 'running',
    payload: {
      verb: 'revise',
      scope: 'section',
      instruction: 'Add a short proof.',
      params: {},
      threadId: null,
      baseContentHash: 'a'.repeat(64),
      model: 'm',
      startedAt: new Date(Date.now() - 12_000).toISOString(),
      ...payload,
    },
    ...overrides,
  });
}
