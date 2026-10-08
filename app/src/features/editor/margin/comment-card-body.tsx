import { useRef, useState } from 'react';
import { CheckCheck, Pencil, RotateCcw, Sparkles, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

import type { Comment } from '@/api/types';
import {
  useCreateCommentMutation,
  useDeleteCommentMutation,
  useResolveCommentMutation,
  useUpdateCommentMutation,
} from '@/api/queries/comments';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { useNow } from '@/features/editor/lib/use-now';
import { formatRelativeTime } from '@/features/runs/lib/run-format';
import type { MarginCardPartProps } from './card-registry';
import { CommentComposer } from './comment-composer';
import { CommentMarkdown } from './comment-markdown';
import { problemMessage } from './errors';
import { draftKey, useMarginStore } from './margin-store';
import { SuggestionBlock } from './suggestion-card';

function isPending(comment: Comment): boolean {
  return comment.id.startsWith('optimistic-');
}

function Message({
  comment,
  own,
  ctx,
  onDelete,
}: {
  comment: Comment;
  own: boolean;
  ctx: MarginCardPartProps['ctx'];
  onDelete: (comment: Comment) => void;
}) {
  const editKey = draftKey(ctx.nodeId, `edit:${comment.id}`);
  const storedEdit = useMarginStore((state) => state.drafts[editKey]);
  // An unsent edit survives the card unmounting: reopen on it.
  const [editing, setEditing] = useState(
    () => useMarginStore.getState().drafts[editKey] !== undefined,
  );
  const editButton = useRef<HTMLButtonElement>(null);
  const update = useUpdateCommentMutation(ctx.projectId, ctx.nodeId, { optimistic: false });
  function closeEdit() {
    setEditing(false);
    // The composer is going away: keyboard focus goes back to the control that opened it.
    requestAnimationFrame(() => editButton.current?.focus());
  }
  const now = useNow();
  const author = comment.authorName ?? 'Someone';
  const relative = formatRelativeTime(comment.createdAt, now);
  const pending = isPending(comment);

  return (
    <li className="group/message flex flex-col gap-1" aria-busy={pending || undefined}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-semibold">{author}</span>
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          <time dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString()}>
            {relative ?? ''}
          </time>
          {comment.editedAt ? (
            <span title={`Edited ${new Date(comment.editedAt).toLocaleString()}`}>· edited</span>
          ) : null}
        </span>
      </div>
      {editing ? (
        <CommentComposer
          label={`Edit comment by ${author}`}
          submitLabel="Save"
          initialValue={storedEdit ?? comment.bodyMarkdown}
          draftKey={editKey}
          onCancel={closeEdit}
          onSubmit={async (text) => {
            if (text !== comment.bodyMarkdown) {
              await update.mutateAsync({ commentId: comment.id, bodyMarkdown: text });
            }
            closeEdit();
          }}
        />
      ) : (
        <>
          <CommentMarkdown>{comment.bodyMarkdown}</CommentMarkdown>
          {own ? (
            <div className="flex gap-1">
              <Button
                ref={editButton}
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Edit comment by ${author}`}
                disabled={pending}
                onClick={() => setEditing(true)}
              >
                <Pencil />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Delete comment by ${author}`}
                disabled={pending}
                onClick={() => onDelete(comment)}
              >
                <Trash2 />
              </Button>
            </div>
          ) : null}
        </>
      )}
    </li>
  );
}

/**
 * Body of a human comment thread: the messages (oldest first), a reply composer, Resolve /
 * Reopen, and Edit / Delete on the user's own messages. Composers stay open with their text until
 * the server accepts it. `Send to Copilot` waits for phase 4 (`ctx.copilotActions`).
 */
export function CommentCardBody({
  thread,
  ctx,
  variant = 'comment',
}: MarginCardPartProps & {
  /**
   * `review`: the root row is a reviewer issue shown by the card's own details above this (not a
   * message), the actions are Fix with Copilot / Dismiss, and nobody can edit or delete the root.
   */
  variant?: 'comment' | 'review';
}) {
  const review = variant === 'review';
  const replyKey = draftKey(ctx.nodeId, `reply:${thread.id}`);
  const storedReply = useMarginStore((state) => state.drafts[replyKey]);
  const [replying, setReplying] = useState(
    () => useMarginStore.getState().drafts[replyKey] !== undefined,
  );
  const [deleting, setDeleting] = useState<Comment | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const replyButton = useRef<HTMLButtonElement>(null);
  const deleteTrigger = useRef<HTMLElement | null>(null);
  /** Moves keyboard focus once the render that removes the focused control has committed. */
  function focusLater(target: 'reply' | 'card') {
    requestAnimationFrame(() => {
      if (target === 'reply') replyButton.current?.focus();
      else bodyRef.current?.closest<HTMLElement>('section[data-thread-id]')?.focus();
    });
  }
  const create = useCreateCommentMutation(ctx.projectId, ctx.nodeId, { optimistic: false });
  const resolve = useResolveCommentMutation(ctx.projectId, ctx.nodeId);
  const remove = useDeleteCommentMutation(ctx.projectId, ctx.nodeId);
  const resolved = thread.status === 'resolved';
  // Suggestions that arrived in this thread (`@copilot`, Send to Copilot) render as their own blocks.
  const replies = thread.replies.filter((reply) => reply.kind !== 'suggestion');
  const suggestions = thread.replies.filter((reply) => reply.kind === 'suggestion');
  const messages = review ? replies : [thread.root, ...replies];
  const rootPending = isPending(thread.root);

  function failed(action: string) {
    return (error: unknown) => toast.error(`Could not ${action}: ${problemMessage(error)}`);
  }

  function requestDelete(comment: Comment) {
    // Deleting a root drops everyone's replies with it, and there is no undo: always confirm it.
    if (comment.id === thread.root.id) setDeleting(comment);
    else {
      remove.mutate(comment.id, { onError: failed('delete the reply') });
      // The reply's own controls disappear with it: keep keyboard focus on this card.
      focusLater('card');
    }
  }

  return (
    <div ref={bodyRef} className="flex flex-col gap-2">
      {messages.length > 0 ? (
        <ul className="flex flex-col gap-3" aria-label="Messages">
          {messages.map((message) => (
            <Message
              key={message.id}
              comment={message}
              own={ctx.currentUserId !== null && message.authorId === ctx.currentUserId}
              ctx={ctx}
              onDelete={(target) => {
                deleteTrigger.current = document.activeElement as HTMLElement | null;
                requestDelete(target);
              }}
            />
          ))}
        </ul>
      ) : null}
      {suggestions.map((suggestion) => (
        <SuggestionBlock key={suggestion.id} suggestion={suggestion} thread={thread} ctx={ctx} />
      ))}

      {replying ? (
        <CommentComposer
          label="Reply"
          placeholder="Reply…"
          submitLabel="Reply"
          initialValue={storedReply ?? ''}
          draftKey={replyKey}
          onCancel={() => {
            setReplying(false);
            focusLater('reply');
          }}
          onSubmit={async (text) => {
            const reply = await create.mutateAsync({
              bodyMarkdown: text,
              parentId: thread.root.id,
            });
            setReplying(false);
            focusLater('reply');
            // A reply that mentions @copilot is a prompt about this thread.
            ctx.onCommentSent?.(reply);
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            ref={replyButton}
            type="button"
            variant="outline"
            size="xs"
            disabled={rootPending}
            onClick={() => setReplying(true)}
          >
            Reply
          </Button>
          {review && ctx.copilotActions && ctx.onFixWithCopilot && !resolved ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => ctx.onFixWithCopilot?.(thread)}
            >
              <Sparkles />
              Fix with Copilot
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={rootPending || resolve.isPending}
            onClick={() => {
              resolve.mutate(
                { commentId: thread.root.id, resolved: !resolved },
                {
                  onError: failed(
                    resolved
                      ? review
                        ? 'restore the issue'
                        : 'reopen the thread'
                      : review
                        ? 'dismiss the issue'
                        : 'resolve the thread',
                  ),
                },
              );
              // Resolving hides the card unless resolved threads are shown: the focus goes with it.
              if (!resolved && !useMarginStore.getState().showResolved) ctx.restoreEditorFocus();
            }}
          >
            {resolved ? <RotateCcw /> : review ? <X /> : <CheckCheck />}
            {resolved ? 'Reopen' : review ? 'Dismiss' : 'Resolve'}
          </Button>
          {!review && ctx.copilotActions && ctx.onSendToCopilot ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => ctx.onSendToCopilot?.(thread)}
            >
              <Sparkles />
              Send to Copilot
            </Button>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
            // Dismissed (Escape, Cancel): back to the control that asked.
            requestAnimationFrame(() => {
              if (document.activeElement === document.body) deleteTrigger.current?.focus();
            });
          }
        }}
        title={thread.replies.length > 0 ? 'Delete this thread?' : 'Delete this comment?'}
        description={
          thread.replies.length > 0
            ? `This also deletes ${thread.replies.length} ${thread.replies.length === 1 ? 'reply' : 'replies'}. It cannot be undone.`
            : 'It cannot be undone.'
        }
        confirmLabel={thread.replies.length > 0 ? 'Delete thread' : 'Delete comment'}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id, { onError: failed('delete the comment') });
          setDeleting(null);
          // The whole card goes away: focus returns to the text.
          ctx.restoreEditorFocus();
        }}
      />
    </div>
  );
}
