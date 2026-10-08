import type { RevisionCreate } from '@/api/types';
import type { DraftCardProps } from './composer-registry';
import type { PromptChips } from './margin-store';
import type { MarginThread } from './threads';

/** Most ids one request may carry (`fixIssueIds` / `addressCommentIds`). */
const MAX_IDS = 25;
export const MAX_INSTRUCTION_LENGTH = 4000;

/** `Selection · 2 sentences`: how much text the prompt is about, in sentences. */
export function countSentences(text: string): number {
  const sentences = text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((part) => part.trim().length > 0);
  return Math.max(1, sentences.length);
}

/** Threads of `kind` that are still open and sit inside the selection (or anywhere, for the whole section). */
export function threadsInScope(
  threads: readonly MarginThread[],
  kind: 'review' | 'comment',
  range: { start: number; end: number } | null,
  sectionScope: boolean,
): MarginThread[] {
  return threads.filter((thread) => {
    if (thread.kind !== kind) return false;
    if (thread.status !== 'open' && thread.status !== 'orphaned') return false;
    if (sectionScope) return true;
    return (
      !!range &&
      thread.range !== null &&
      thread.range.start < range.end &&
      thread.range.end > range.start
    );
  });
}

/** Whether any chip is on. */
export function anyChip(chips: PromptChips): boolean {
  return (
    chips.moreProofs ||
    chips.moreExamples ||
    chips.moreRigorous ||
    chips.length !== null ||
    chips.citeSources ||
    chips.fixIssues ||
    chips.addressComments
  );
}

/** The request the window sends. Chips are typed fields, never pasted into the instruction. */
export function buildRevisionRequest(options: {
  verb: 'revise' | 'rewrite';
  anchor: DraftCardProps['draft']['anchor'];
  instruction: string;
  chips: PromptChips;
  threadId?: string | null;
  fixIssueIds: string[];
  addressCommentIds: string[];
}): RevisionCreate {
  const { verb, anchor, instruction, chips } = options;
  if (verb === 'rewrite') return { verb: 'rewrite', instruction };
  return {
    verb: 'revise',
    scope: anchor ? 'range' : 'section',
    ...(anchor ? { anchor } : {}),
    instruction,
    ...(options.threadId ? { threadId: options.threadId } : {}),
    params: {
      moreProofs: chips.moreProofs,
      moreExamples: chips.moreExamples,
      moreRigorous: chips.moreRigorous,
      shorter: chips.length === 'shorter',
      longer: chips.length === 'longer',
      citeSources: chips.citeSources,
      fixIssueIds: chips.fixIssues ? options.fixIssueIds.slice(0, MAX_IDS) : [],
      addressCommentIds: chips.addressComments ? options.addressCommentIds.slice(0, MAX_IDS) : [],
    },
  };
}
