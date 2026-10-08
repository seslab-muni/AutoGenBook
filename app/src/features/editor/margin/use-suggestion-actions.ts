import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { baseContentHash } from '@/api/queries/outline';
import {
  useAcceptSuggestionMutation,
  useCancelSuggestionMutation,
  useRejectSuggestionMutation,
  useRestoreContentMutation,
} from '@/api/queries/revisions';
import { useDeleteCommentMutation } from '@/api/queries/comments';
import { projectKeys } from '@/api/queries/keys';
import type { Comment, OutlineNode } from '@/api/types';
import type { MarginCardContext } from './card-registry';
import { describeAcceptError, isContentConflict, type CopilotFailure } from './copilot-errors';
import { problemMessage } from './errors';

export type ActionResult = { ok: true } | { ok: false; failure: CopilotFailure };

const UNDO_TOAST_MS = 12_000;

/**
 * What a suggestion card can do. `accept` is the data-loss-sensitive one, so its order is fixed:
 *
 *  1. `ctx.holdSaving()` saves whatever is pending (the server accepts against the *saved* text)
 *     and then holds autosave, so no save of the old draft can land after the accept;
 *  2. POST accept with `expectedContentHash`, the hash of the text just saved (the server's own
 *     `contentHash` from the last response, not one computed here) and, for a partial accept, the
 *     chosen `hunkIndexes`;
 *  3. on success the returned node is written into the caches and the open editor adopts its text
 *     (kept out of the undo history), unless the user typed during the accept, in which case their
 *     draft stays and the "changed elsewhere" notice offers the choice;
 *  4. the hold is released whatever happened. On any failure the draft is untouched.
 *
 * `Ctrl+Z` cannot take an accept back (the adopted text is not in the editor's history), so a
 * toast offers *Undo*, which writes the previous text back guarded by the hash the accept returned.
 */
export function useSuggestionActions(ctx: MarginCardContext) {
  const queryClient = useQueryClient();
  const accept = useAcceptSuggestionMutation(ctx.projectId, ctx.nodeId);
  const reject = useRejectSuggestionMutation(ctx.projectId, ctx.nodeId);
  const cancel = useCancelSuggestionMutation(ctx.projectId, ctx.nodeId);
  const restore = useRestoreContentMutation(ctx.projectId, ctx.nodeId);
  const remove = useDeleteCommentMutation(ctx.projectId, ctx.nodeId);
  // The latest context, read only when an action runs (never while rendering).
  const ctxRef = useRef(ctx);
  useEffect(() => {
    ctxRef.current = ctx;
  });

  const undo = useCallback(
    async (previous: string, appliedHash: string) => {
      const c = ctxRef.current;
      let release: (() => void) | undefined;
      try {
        release = await c.holdSaving();
      } catch (error) {
        toast.error(`Could not undo: ${problemMessage(error)}`);
        return;
      }
      try {
        await restore.mutateAsync({ contentMarkdown: previous, expectedContentHash: appliedHash });
        if (!c.hasUnsavedEdits()) c.applyServerContent(previous);
        toast.success('Suggestion undone');
      } catch (error) {
        toast.error(
          isContentConflict(error)
            ? 'The section was edited after the suggestion was applied, so it was left as it is. Undo it by hand.'
            : `Could not undo: ${problemMessage(error)}`,
        );
      } finally {
        release();
      }
    },
    [restore],
  );

  const acceptSuggestion = useCallback(
    async (suggestion: Comment, hunkIndexes?: number[]): Promise<ActionResult> => {
      const c = ctxRef.current;
      let release: (() => void) | undefined;
      try {
        release = await c.holdSaving();
      } catch (error) {
        return {
          ok: false,
          failure: {
            message: `Your latest edits could not be saved first, so nothing was applied: ${problemMessage(error)}`,
            code: null,
          },
        };
      }
      try {
        const previous = queryClient.getQueryData<OutlineNode>(
          projectKeys.outlineNode(c.projectId, c.nodeId),
        )?.contentMarkdown;
        const expectedContentHash = await baseContentHash(queryClient, c.projectId, c.nodeId);
        const result = await accept.mutateAsync({
          suggestionId: suggestion.id,
          ...(hunkIndexes ? { hunkIndexes } : {}),
          expectedContentHash,
        });
        if (!c.hasUnsavedEdits()) c.applyServerContent(result.node.contentMarkdown);
        const appliedHash = result.node.contentHash;
        toast.success('Suggestion applied', {
          duration: UNDO_TOAST_MS,
          ...(previous !== undefined && appliedHash
            ? { action: { label: 'Undo', onClick: () => void undo(previous, appliedHash) } }
            : {}),
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, failure: describeAcceptError(error) };
      } finally {
        release();
      }
    },
    [accept, queryClient, undo],
  );

  const rejectSuggestion = useCallback(
    async (suggestion: Comment): Promise<ActionResult> => {
      try {
        await reject.mutateAsync(suggestion.id);
        return { ok: true };
      } catch (error) {
        return { ok: false, failure: { message: problemMessage(error), code: null } };
      }
    },
    [reject],
  );

  const cancelSuggestion = useCallback(
    async (suggestion: Comment): Promise<ActionResult> => {
      try {
        await cancel.mutateAsync(suggestion.id);
        return { ok: true };
      } catch (error) {
        return { ok: false, failure: { message: problemMessage(error), code: null } };
      }
    },
    [cancel],
  );

  const dismissSuggestion = useCallback(
    async (suggestion: Comment): Promise<ActionResult> => {
      try {
        await remove.mutateAsync(suggestion.id);
        return { ok: true };
      } catch (error) {
        return { ok: false, failure: { message: problemMessage(error), code: null } };
      }
    },
    [remove],
  );

  return {
    acceptSuggestion,
    rejectSuggestion,
    cancelSuggestion,
    dismissSuggestion,
    busy: accept.isPending || reject.isPending || cancel.isPending || remove.isPending,
  };
}
