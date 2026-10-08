import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';

import { useStartRevisionMutation } from '@/api/queries/revisions';
import type { Comment, CommentAnchorIn, RevisionCreate, StartedRevision } from '@/api/types';
import { useRightColumn } from '@/components/layout/use-right-pane';
import { handleLlmKeyRequired } from '@/features/account/lib/llm-key-error';
import { anchorFromUnitRange, type Anchor } from '@/features/editor/lib/anchors';
import { suggestionPayload } from '@/features/editor/lib/card-payloads';
import { toServerAnchor } from '@/features/editor/lib/server-anchor';
import { trackRun } from '@/features/runs/hooks/use-run-stream';
import { mentionsCopilot } from './mentions';
import { describeStartError } from './copilot-errors';
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

interface UseCopilotOptions {
  projectId: string;
  nodeId: string;
  /** The editor's current text (LF line endings; what live ranges index into). */
  getText: () => string;
  flushEdits: () => Promise<void>;
  /** The section can be revised (Markdown). A LaTeX-only section only has Rewrite. */
  enabled: boolean;
  /** An anchor in the form the server takes, given the text it stores (see `toServerAnchor`). */
  serverAnchor: (anchor: Parameters<typeof toServerAnchor>[0]) => CommentAnchorIn | null;
}

/** The anchor a request can carry for a thread: its live range when it has one, else its stored one. */
function threadAnchor(
  thread: MarginThread,
  row: Comment,
  text: string,
  serverAnchor: UseCopilotOptions['serverAnchor'],
): CommentAnchorIn | null {
  // Standalone card: its live range follows the text; otherwise the row's own anchor.
  if (thread.id === row.id && thread.range) {
    const live = anchorFromUnitRange(text, thread.range.start, thread.range.end);
    return serverAnchor(live);
  }
  const stored = row.anchor;
  if (!stored || typeof stored.start !== 'number' || typeof stored.end !== 'number') return null;
  return serverAnchor(stored);
}

/**
 * The copilot's entry points for one open section (issue #182 phase 4): they all end in
 * `startRevision`, which saves the pending edits first (the server revises the saved text), posts,
 * and shows the new suggestion's card. The prompt window shows a refusal inline; every other entry
 * (a chip, Send to Copilot, Fix with Copilot, an `@copilot` comment) has no place for one and toasts it.
 *
 * Everything returned is referentially stable (handlers read the latest values through a ref), so the
 * card context built from it does not change while the user types: a changing context would
 * re-render every card on every keystroke.
 */
export function useCopilot(options: UseCopilotOptions) {
  const queryClient = useQueryClient();
  const start = useStartRevisionMutation(options.projectId, options.nodeId);
  const navigate = useNavigate();
  const { revealMargin } = useRightColumn();
  const revealCard = useMarginStore((state) => state.revealCard);
  const focusCard = useMarginStore((state) => state.focusCard);
  const openPromptDraft = useMarginStore((state) => state.openPrompt);

  const latest = useRef({
    ...options,
    startMutation: start.mutateAsync,
    navigate,
    revealMargin,
    revealCard,
    focusCard,
    openPromptDraft,
    queryClient,
  });
  useEffect(() => {
    latest.current = {
      ...options,
      startMutation: start.mutateAsync,
      navigate,
      revealMargin,
      revealCard,
      focusCard,
      openPromptDraft,
      queryClient,
    };
  });
  const quickBusy = useRef(false);

  return useMemo(() => {
    const startRevision = async (
      request: RevisionCreate,
      opts: { moveFocus?: boolean } = {},
    ): Promise<StartedRevision> => {
      const l = latest.current;
      await l.flushEdits();
      const started = await l.startMutation(request);
      if (started.kind === 'suggestion') {
        l.revealMargin();
        const id = started.suggestion.threadId;
        if (opts.moveFocus) l.focusCard(id);
        else l.revealCard(id);
      } else {
        // A short run can start and finish between two polls of the run list, which would never
        // follow it: follow this one by its id, so the outline and the outcome toast are not missed.
        trackRun(started.runId, l.queryClient, l.projectId);
        toast.success('Rewrite started', {
          description: 'It runs as a regenerate run; follow it on the runs page.',
          duration: 10_000,
          action: {
            label: 'View run',
            onClick: () =>
              void l.navigate({
                to: '/p/$projectId/runs/$runId',
                params: { projectId: l.projectId, runId: started.runId },
              }),
          },
        });
      }
      return started;
    };

    /** Starts without a window: failures become a toast. One at a time. */
    const quick = async (request: RevisionCreate): Promise<void> => {
      if (quickBusy.current) return;
      quickBusy.current = true;
      try {
        await startRevision(request);
      } catch (error) {
        if (handleLlmKeyRequired(error)) return;
        toast.error(describeStartError(error, request.verb ?? 'revise').message);
      } finally {
        quickBusy.current = false;
      }
    };

    const openPrompt = (
      anchor: Anchor | null,
      origin: PromptOrigin,
      o: {
        text?: string;
        chips?: PromptChips;
        verb?: 'revise' | 'rewrite';
        replaces?: { id: string; status: string } | null;
        threadId?: string | null;
        notice?: string;
        explicit?: boolean;
      } = {},
    ) => {
      const l = latest.current;
      // A section that cannot be revised (LaTeX) only has Rewrite, for the whole section.
      const revisable = l.enabled;
      l.openPromptDraft(
        {
          kind: 'prompt',
          anchor: revisable ? anchor : null,
          verb: revisable ? (o.verb ?? 'revise') : 'rewrite',
          chips: o.chips ?? noChips(),
          origin,
          replaces: o.replaces ?? null,
          threadId: o.threadId ?? null,
          notice: o.notice,
        },
        l.nodeId,
        { ...(o.text !== undefined ? { text: o.text } : {}), explicit: o.explicit ?? false },
      );
      l.revealMargin();
      // The window is tall: bring it fully into view when it opens near the bottom of the text.
      l.revealCard(DRAFT_ID);
    };

    return {
      startRevision,
      openPrompt,
      /** Selection toolbar chip: sends at once, range scope, that one parameter. */
      runChip: (chip: string, anchor: Parameters<typeof toServerAnchor>[0]) => {
        const params = CHIP_PARAMS[chip as QuickChip];
        const server = latest.current.serverAnchor(anchor);
        if (!params || !server) return;
        void quick({ verb: 'revise', scope: 'range', anchor: server, instruction: '', params });
      },
      sendToCopilot: (thread: MarginThread) => {
        const l = latest.current;
        const anchor = threadAnchor(thread, thread.root, l.getText(), l.serverAnchor);
        void quick({
          verb: 'revise',
          scope: anchor ? 'range' : 'section',
          ...(anchor ? { anchor } : {}),
          instruction: '',
          params: {},
          threadId: thread.id,
        });
      },
      fixWithCopilot: (thread: MarginThread) => {
        const l = latest.current;
        const anchor = threadAnchor(thread, thread.root, l.getText(), l.serverAnchor);
        void quick({
          verb: 'revise',
          scope: anchor ? 'range' : 'section',
          ...(anchor ? { anchor } : {}),
          instruction: '',
          params: { fixIssueIds: [thread.id] },
        });
      },
      /** A comment or reply that mentions `@copilot` has just been saved: the suggestion arrives in its thread. */
      commentSent: (comment: Comment) => {
        const l = latest.current;
        if (!l.enabled || !mentionsCopilot(comment.bodyMarkdown)) return;
        const anchor =
          comment.status === 'orphaned' ? null : l.serverAnchor(comment.anchor ?? null);
        void quick({
          verb: 'revise',
          scope: anchor && comment.anchor?.start != null ? 'range' : 'section',
          ...(anchor && comment.anchor?.start != null ? { anchor } : {}),
          instruction: '',
          params: {},
          threadId: comment.threadId,
        });
      },
      /** Try again: the prompt window, filled in with what the suggestion was asked. */
      tryAgain: (suggestion: Comment, thread: MarginThread) => {
        const l = latest.current;
        const payload = suggestionPayload(suggestion);
        const server =
          payload.scope === 'range'
            ? threadAnchor(thread, suggestion, l.getText(), l.serverAnchor)
            : null;
        const lostRange = payload.scope === 'range' && !server;
        openPrompt(
          server
            ? {
                quote: server.quote,
                prefix: server.prefix ?? '',
                suffix: server.suffix ?? '',
                start: server.start ?? null,
                end: server.end ?? null,
              }
            : null,
          'retry',
          {
            explicit: true,
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
            ...(lostRange
              ? {
                  notice:
                    'The text this was about is gone, so this will revise the whole section. Select the text again to aim at a passage.',
                }
              : {}),
          },
        );
      },
    };
  }, []);
}
