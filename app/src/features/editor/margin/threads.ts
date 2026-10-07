import type { Comment, CommentKind } from '@/api/types';
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

/** Whether a thread is finished with: resolved, or a suggestion that was acted on. */
export function isClosed(thread: Pick<MarginThread, 'kind' | 'status'>): boolean {
  if (thread.kind === 'suggestion') {
    return ['accepted', 'rejected', 'failed', 'cancelled'].includes(thread.status);
  }
  return thread.status === 'resolved';
}

export function filterThreads(
  threads: readonly MarginThread[],
  filter: MarginFilter,
  showResolved: boolean,
): MarginThread[] {
  return threads.filter(
    (thread) => (filter === 'all' || thread.kind === filter) && (showResolved || !isClosed(thread)),
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
