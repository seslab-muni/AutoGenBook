import type { Comment } from '@/api/types';
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
    sectionLevel,
    quote: options.quote ?? root.anchor?.quote ?? '',
  };
}
