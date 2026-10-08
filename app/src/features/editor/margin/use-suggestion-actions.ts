import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { create } from 'zustand';

import { projectKeys } from '@/api/queries/keys';
import { useDeleteCommentMutation, useResolveCommentMutation } from '@/api/queries/comments';
import { baseContentHash } from '@/api/queries/outline';
import {
  useAcceptSuggestionMutation,
  useCancelSuggestionMutation,
  useRejectSuggestionMutation,
  useRestoreContentMutation,
} from '@/api/queries/revisions';
import type { Comment, OutlineNode, Page } from '@/api/types';
import { suggestionPayload } from '@/features/editor/lib/card-payloads';
import type { MarginCardContext } from './card-registry';
import { describeAcceptError, isContentConflict, type CopilotFailure } from './copilot-errors';
import { problemMessage } from './errors';

export type ActionResult = { ok: true } | { ok: false; failure: CopilotFailure };

const UNDO_TOAST_MS = 12_000;

/**
 * Suggestions whose text was restored with Undo in this session. The server has no such state (an
 * undo is an ordinary content write), so the card says "Accepted, then undone" only while this tab
 * remembers it; after a reload it reads Accepted again.
 */
export const useUndoneSuggestions = create<{
  ids: Record<string, true>;
  mark: (id: string) => void;
}>()((set) => ({
  ids: {},
  mark: (id) => set((state) => ({ ids: { ...state.ids, [id]: true } })),
}));

/** The rows an accept of everything settles, that are still open right now: what an undo reopens. */
function rowsSettledByAccept(
  rows: readonly Comment[],
  payload: ReturnType<typeof suggestionPayload>,
): string[] {
  const ids = new Set<string>([
    ...(payload.threadId ? [payload.threadId] : []),
    ...payload.params.fixIssueIds,
    ...payload.params.addressCommentIds,
  ]);
  return rows
    .filter((row) => ids.has(row.id) && row.parentId === null && row.status !== 'resolved')
    .map((row) => row.id);
}

/**
 * What a suggestion card can do. `accept` is the data-loss-sensitive one, so its order is fixed:
 *
 *  1. `ctx.holdSaving()` saves whatever is pending (the server accepts against the *saved* text)
 *     and then holds autosave, so no save of the old draft can land after the accept;
 *  2. POST accept with `expectedContentHash`, the hash of the text just saved (the server's own
 *     `contentHash`, not one computed here) and, for a partial accept, the chosen `hunkIndexes`;
 *  3. on success the returned node is written into the caches and `ctx.applyServerContent` hands the
 *     editor the new text: adopted at once when nothing is unsaved, otherwise the draft stays as typed
 *     and the "changed elsewhere" notice offers the choice;
 *  4. the hold is released in a `finally`. On any failure the draft is untouched.
 *
 * One action at a time per card (the in-flight guard also covers the flush before the POST).
 * `Ctrl+Z` cannot take an accept back (the adopted text is not in the editor's history), so a toast
 * offers *Undo*, which writes the previous text back guarded by the hash the accept returned (the same
 * hold, the same adoption) and reopens the threads and issues the accept had resolved.
 */
export function useSuggestionActions(ctx: MarginCardContext) {
  const queryClient = useQueryClient();
  const accept = useAcceptSuggestionMutation(ctx.projectId, ctx.nodeId);
  const reject = useRejectSuggestionMutation(ctx.projectId, ctx.nodeId);
  const cancel = useCancelSuggestionMutation(ctx.projectId, ctx.nodeId);
  const restore = useRestoreContentMutation(ctx.projectId, ctx.nodeId);
  const remove = useDeleteCommentMutation(ctx.projectId, ctx.nodeId);
  const resolve = useResolveCommentMutation(ctx.projectId, ctx.nodeId);
  // The latest context, read only when an action runs (never while rendering).
  const ctxRef = useRef(ctx);
  useEffect(() => {
    ctxRef.current = ctx;
  });
  const inFlight = useRef(false);

  const undo = useCallback(
    async (previous: string, appliedHash: string, suggestionId: string, reopen: string[]) => {
      const c = ctxRef.current;
      let release: (() => void) | undefined;
      try {
        release = await c.holdSaving();
      } catch (error) {
        toast.error(`Could not undo: ${problemMessage(error)}`);
        return;
      }
      try {
        const node = await restore.mutateAsync({
          contentMarkdown: previous,
          expectedContentHash: appliedHash,
        });
        c.applyServerContent(node.contentMarkdown, node.contentHash ?? null);
        useUndoneSuggestions.getState().mark(suggestionId);
        // The accept closed these threads and issues; the restored text is back to what they were about.
        await Promise.allSettled(
          reopen.map((commentId) => resolve.mutateAsync({ commentId, resolved: false })),
        );
        toast.success('Text restored', {
          description:
            reopen.length > 0
              ? 'The suggestion stays marked accepted; the comments and issues it closed are open again.'
              : 'The suggestion stays marked accepted.',
        });
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
    [restore, resolve],
  );

  const acceptSuggestion = useCallback(
    async (suggestion: Comment, hunkIndexes?: number[]): Promise<ActionResult> => {
      if (inFlight.current) return { ok: true };
      inFlight.current = true;
      const c = ctxRef.current;
      let release: (() => void) | undefined;
      try {
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
          const nodeKey = projectKeys.outlineNode(c.projectId, c.nodeId);
          const previous = queryClient.getQueryData<OutlineNode>(nodeKey)?.contentMarkdown;
          const payload = suggestionPayload(suggestion);
          // What a full accept will settle, read before the answer changes the rows.
          const reopen = hunkIndexes
            ? []
            : rowsSettledByAccept(
                queryClient.getQueryData<Page<Comment>>(
                  projectKeys.nodeComments(c.projectId, c.nodeId),
                )?.items ?? [],
                payload,
              );
          const expectedContentHash = await baseContentHash(queryClient, c.projectId, c.nodeId);
          const result = await accept.mutateAsync({
            suggestionId: suggestion.id,
            ...(hunkIndexes ? { hunkIndexes } : {}),
            expectedContentHash,
          });
          c.applyServerContent(result.node.contentMarkdown, result.node.contentHash ?? null);
          const appliedHash = result.node.contentHash;
          toast.success('Suggestion applied', {
            duration: UNDO_TOAST_MS,
            ...(previous !== undefined && appliedHash
              ? {
                  action: {
                    label: 'Undo',
                    onClick: () => void undo(previous, appliedHash, suggestion.id, reopen),
                  },
                }
              : {}),
          });
          return { ok: true };
        } catch (error) {
          return { ok: false, failure: describeAcceptError(error) };
        }
      } finally {
        release?.();
        inFlight.current = false;
      }
    },
    [accept, queryClient, undo],
  );

  const transition = useCallback(async (task: () => Promise<unknown>): Promise<ActionResult> => {
    if (inFlight.current) return { ok: true };
    inFlight.current = true;
    try {
      await task();
      return { ok: true };
    } catch (error) {
      return { ok: false, failure: { message: problemMessage(error), code: null } };
    } finally {
      inFlight.current = false;
    }
  }, []);

  const rejectSuggestion = useCallback(
    (suggestion: Comment) => transition(() => reject.mutateAsync(suggestion.id)),
    [reject, transition],
  );
  const cancelSuggestion = useCallback(
    (suggestion: Comment) => transition(() => cancel.mutateAsync(suggestion.id)),
    [cancel, transition],
  );
  const dismissSuggestion = useCallback(
    (suggestion: Comment) => transition(() => remove.mutateAsync(suggestion.id)),
    [remove, transition],
  );

  return {
    acceptSuggestion,
    rejectSuggestion,
    cancelSuggestion,
    dismissSuggestion,
    busy: accept.isPending || reject.isPending || cancel.isPending || remove.isPending,
  };
}
