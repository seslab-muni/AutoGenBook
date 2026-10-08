import type { Comment, CommentKind } from '@/api/types';
import { reviewPayload } from '@/features/editor/lib/card-payloads';
import type { TextRange } from '@/features/editor/lib/anchors';

/** One margin card's data: a thread root and its replies, plus where its anchor sits right now. */
export interface MarginThread {
  /** The root row's id (`threadId`). */
  id: string;
  kind: CommentKind;
  root: Comment;
  /** Replies, oldest first. */
  replies: Comment[];
  /** `root.status`, which replies mirror. */
  status: Comment['status'];
  /** Where the anchor sits in the current draft (UTF-16 offsets), `null` for a section-level or orphaned card. */
  range: TextRange | null;
  /** The anchor has no place in the text any more (never true for a section-level card). */
  orphaned: boolean;
  /** No position yet but a search for one is still due (e.g. just after an edit): not known to be orphaned. */
  pending: boolean;
  /** Section-level card: no anchor at all. */
  sectionLevel: boolean;
  /** The quoted text: the live text of the range when there is one, else what the anchor stored. */
  quote: string;
}

export type MarginFilter = 'all' | CommentKind;

/** Groups the API's flat, thread-contiguous list into threads (roots in list order). */
export function groupThreads(rows: readonly Comment[]): Comment[][] {
  const byThread = new Map<string, Comment[]>();
  for (const row of rows) {
    const list = byThread.get(row.threadId) ?? [];
    list.push(row);
    byThread.set(row.threadId, list);
  }
  const out: Comment[][] = [];
  for (const [threadId, list] of byThread) {
    const root = list.find((row) => row.id === threadId);
    if (!root) continue;
    out.push([root, ...list.filter((row) => row !== root)]);
  }
  return out;
}

/**
 * Whether a thread is finished with: resolved, or a suggestion that was accepted or rejected. A
 * failed or cancelled suggestion is not: it stays in the margin (with Try again and Dismiss) until
 * the person who asked has seen it and dismissed it.
 */
export function isClosed(thread: Pick<MarginThread, 'kind' | 'status'>): boolean {
  if (thread.kind === 'suggestion') {
    return thread.status === 'accepted' || thread.status === 'rejected';
  }
  return thread.status === 'resolved';
}

/** Whether the thread has a live row of `kind`: a suggestion can sit inside the comment thread that prompted it. */
export function hasKind(
  thread: Pick<MarginThread, 'kind' | 'root' | 'replies'>,
  kind: CommentKind,
): boolean {
  return thread.kind === kind || thread.replies.some((reply) => reply.kind === kind);
}

/**
 * A thread is finished with when it is resolved, or a suggestion that was acted on. A comment
 * thread that holds a suggestion still waiting (running or pending) is not finished, resolved or not.
 */
export function isThreadClosed(thread: Pick<MarginThread, 'kind' | 'status' | 'replies'>): boolean {
  return isClosed(thread) && !thread.replies.some(isWaitingSuggestion);
}

function isWaitingSuggestion(row: Comment): boolean {
  return row.kind === 'suggestion' && (row.status === 'running' || row.status === 'pending');
}

export function filterThreads(
  threads: readonly MarginThread[],
  filter: MarginFilter,
  showResolved: boolean,
): MarginThread[] {
  return threads.filter(
    (thread) =>
      (filter === 'all' || hasKind(thread, filter)) && (showResolved || !isThreadClosed(thread)),
  );
}

/**
 * Display order: section-level and orphaned cards first (pinned at the top, oldest first), then
 * the anchored ones by where they sit in the text.
 */
export function compareThreads(a: MarginThread, b: MarginThread): number {
  const pinnedA = a.range === null;
  const pinnedB = b.range === null;
  if (pinnedA !== pinnedB) return pinnedA ? -1 : 1;
  if (a.range && b.range && (a.range.start !== b.range.start || a.range.end !== b.range.end)) {
    return a.range.start - b.range.start || a.range.end - b.range.end;
  }
  return a.root.createdAt.localeCompare(b.root.createdAt) || a.id.localeCompare(b.id);
}

/** Open (not dismissed) review cards by severity. */
export function countOpenIssues(threads: readonly MarginThread[]): {
  major: number;
  minor: number;
} {
  let major = 0;
  let minor = 0;
  for (const thread of threads) {
    if (thread.kind !== 'review' || thread.status === 'resolved') continue;
    if (reviewPayload(thread.root).severity === 'major') major += 1;
    else minor += 1;
  }
  return { major, minor };
}
