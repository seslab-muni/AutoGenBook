import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';

import { useStartRevisionMutation } from '@/api/queries/revisions';
import type { Comment, RevisionCreate, StartedRevision } from '@/api/types';
import { useRightColumn } from '@/components/layout/use-right-pane';
import { handleLlmKeyRequired } from '@/features/account/lib/llm-key-error';
import { anchorFromUnitRange, type Anchor } from '@/features/editor/lib/anchors';
import { suggestionPayload } from '@/features/editor/lib/card-payloads';
import { describeStartError } from './copilot-errors';
import { problemMessage } from './errors';
import {
  DRAFT_ID,
  noChips,
  useMarginStore,
  type PromptChips,
  type PromptOrigin,
} from './margin-store';
import type { MarginThread } from './threads';

/** The selection toolbar's quick chips and the one parameter each sends. */
export const CHIP_PARAMS = {
  'Add proof': { moreProofs: true },
  'More rigorous': { moreRigorous: true },
  Shorter: { shorter: true },
  Cite: { citeSources: true },
} as const;
export type QuickChip = keyof typeof CHIP_PARAMS;

/** A comment that mentions `@copilot` is a prompt. */
export function mentionsCopilot(text: string): boolean {
  return /(^|[^\w@])@copilot\b/i.test(text);
}

interface UseCopilotOptions {
  projectId: string;
  nodeId: string;
  /** The editor's current text (LF line endings; what live ranges index into). */
  getText: () => string;
  flushEdits: () => Promise<void>;
  /** The server anchors against Markdown: a LaTeX-only section has no revisions. */
  enabled: boolean;
}

/** An anchor a request can carry, from a thread: its live range when it has one, else its stored one. */
function threadAnchor(thread: MarginThread, text: string): Anchor | null {
  if (thread.range) return anchorFromUnitRange(text, thread.range.start, thread.range.end);
  const stored = thread.root.anchor;
  if (
    !thread.orphaned &&
    stored &&
    typeof stored.start === 'number' &&
    typeof stored.end === 'number'
  ) {
    return {
      quote: stored.quote ?? '',
      prefix: stored.prefix ?? '',
      suffix: stored.suffix ?? '',
      start: stored.start,
      end: stored.end,
    };
  }
  return null;
}

/**
 * The copilot's entry points for one open section (issue #182 phase 4): they all end in
 * `startRevision`, which saves the pending edits first (the server revises the saved text), posts,
 * and shows the new suggestion's card. The prompt window shows a refusal inline; every other entry
 * (a chip, Send to Copilot, Fix with Copilot, an `@copilot` comment) has no place for one and toasts it.
 */
export function useCopilot({ projectId, nodeId, getText, flushEdits, enabled }: UseCopilotOptions) {
  const start = useStartRevisionMutation(projectId, nodeId);
  const navigate = useNavigate();
  const { revealMargin } = useRightColumn();
  const revealCard = useMarginStore((state) => state.revealCard);
  const focusCard = useMarginStore((state) => state.focusCard);
  const openPromptDraft = useMarginStore((state) => state.openPrompt);

  const latest = useRef({ flushEdits, getText, enabled });
  useEffect(() => {
    latest.current = { flushEdits, getText, enabled };
  });

  const startRevision = useCallback(
    async (
      request: RevisionCreate,
      options: { moveFocus?: boolean } = {},
    ): Promise<StartedRevision> => {
      await latest.current.flushEdits();
      const started = await start.mutateAsync(request);
      if (started.kind === 'suggestion') {
        revealMargin();
        const id = started.suggestion.threadId;
        if (options.moveFocus) focusCard(id);
        else revealCard(id);
      } else {
        toast.success('Rewrite started', {
          description: 'It runs as a regenerate run; follow it on the runs page.',
          duration: 10_000,
          action: {
            label: 'View run',
            onClick: () =>
              void navigate({
                to: '/p/$projectId/runs/$runId',
                params: { projectId, runId: started.runId },
              }),
          },
        });
      }
      return started;
    },
    [start, revealMargin, revealCard, focusCard, navigate, projectId],
  );

  /** Starts without a window: failures become a toast. */
  const quick = useCallback(
    async (request: RevisionCreate): Promise<void> => {
      try {
        await startRevision(request);
      } catch (error) {
        if (handleLlmKeyRequired(error)) return;
        const failure = describeStartError(error);
        toast.error(
          failure.code ? failure.message : `Could not start the copilot: ${problemMessage(error)}`,
        );
      }
    },
    [startRevision],
  );

  const openPrompt = useCallback(
    (
      anchor: Anchor | null,
      origin: PromptOrigin,
      options: {
        text?: string;
        chips?: PromptChips;
        verb?: 'revise' | 'rewrite';
        replaces?: { id: string; status: string } | null;
        threadId?: string | null;
      } = {},
    ) => {
      if (!latest.current.enabled) return;
      openPromptDraft(
        {
          kind: 'prompt',
          anchor,
          verb: options.verb ?? 'revise',
          chips: options.chips ?? noChips(),
          origin,
          replaces: options.replaces ?? null,
          threadId: options.threadId ?? null,
        },
        nodeId,
        options.text ?? '',
      );
      revealMargin();
      // The window is tall: bring it fully into view when it opens near the bottom of the text.
      revealCard(DRAFT_ID);
    },
    [openPromptDraft, nodeId, revealMargin, revealCard],
  );

  /** Selection toolbar chip: sends at once, range scope, that one parameter. */
  const runChip = useCallback(
    (chip: string, anchor: Anchor) => {
      const params = CHIP_PARAMS[chip as QuickChip];
      if (!params) return;
      void quick({ verb: 'revise', scope: 'range', anchor, instruction: '', params });
    },
    [quick],
  );

  const sendToCopilot = useCallback(
    (thread: MarginThread) => {
      const anchor = threadAnchor(thread, latest.current.getText());
      void quick({
        verb: 'revise',
        scope: anchor ? 'range' : 'section',
        ...(anchor ? { anchor } : {}),
        instruction: '',
        params: {},
        threadId: thread.id,
      });
    },
    [quick],
  );

  const fixWithCopilot = useCallback(
    (thread: MarginThread) => {
      const anchor = threadAnchor(thread, latest.current.getText());
      void quick({
        verb: 'revise',
        scope: anchor ? 'range' : 'section',
        ...(anchor ? { anchor } : {}),
        instruction: '',
        params: { fixIssueIds: [thread.id] },
      });
    },
    [quick],
  );

  /** A comment or reply that mentions `@copilot` has just been saved: the suggestion arrives in its thread. */
  const commentSent = useCallback(
    (comment: Comment) => {
      if (!latest.current.enabled || !mentionsCopilot(comment.bodyMarkdown)) return;
      const stored = comment.anchor;
      const ranged =
        !!stored &&
        comment.status !== 'orphaned' &&
        typeof stored.start === 'number' &&
        typeof stored.end === 'number';
      void quick({
        verb: 'revise',
        scope: ranged ? 'range' : 'section',
        ...(ranged && stored
          ? {
              anchor: {
                quote: stored.quote ?? '',
                prefix: stored.prefix ?? '',
                suffix: stored.suffix ?? '',
                start: stored.start ?? null,
                end: stored.end ?? null,
              },
            }
          : {}),
        instruction: '',
        params: {},
        threadId: comment.threadId,
      });
    },
    [quick],
  );

  /** Try again: the prompt window, filled in with what the suggestion was asked. */
  const tryAgain = useCallback(
    (suggestion: Comment, thread: MarginThread) => {
      const payload = suggestionPayload(suggestion);
      const anchor =
        payload.scope === 'range' ? threadAnchor(thread, latest.current.getText()) : null;
      openPrompt(anchor, 'retry', {
        text: payload.instruction,
        chips: {
          moreProofs: payload.params.moreProofs,
          moreExamples: payload.params.moreExamples,
          moreRigorous: payload.params.moreRigorous,
          length: payload.params.shorter ? 'shorter' : payload.params.longer ? 'longer' : null,
          citeSources: payload.params.citeSources,
          fixIssues: payload.params.fixIssueIds.length > 0,
          addressComments: payload.params.addressCommentIds.length > 0,
        },
        replaces: { id: suggestion.id, status: suggestion.status },
        threadId: payload.threadId,
      });
    },
    [openPrompt],
  );

  return {
    startRevision,
    openPrompt,
    runChip,
    sendToCopilot,
    fixWithCopilot,
    commentSent,
    tryAgain,
  };
}
