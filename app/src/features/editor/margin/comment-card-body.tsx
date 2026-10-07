import { useState } from 'react';
import { CheckCheck, Pencil, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
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
  const [editing, setEditing] = useState(false);
  const update = useUpdateCommentMutation(ctx.projectId, ctx.nodeId, { optimistic: false });
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
          initialValue={comment.bodyMarkdown}
          onCancel={() => {
            setEditing(false);
            ctx.restoreEditorFocus();
          }}
          onSubmit={async (text) => {
            if (text !== comment.bodyMarkdown) {
              await update.mutateAsync({ commentId: comment.id, bodyMarkdown: text });
            }
            setEditing(false);
          }}
        />
      ) : (
        <>
          <CommentMarkdown>{comment.bodyMarkdown}</CommentMarkdown>
          {own ? (
            <div className="flex gap-1">
              <Button
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
export function CommentCardBody({ thread, ctx }: MarginCardPartProps) {
  const [replying, setReplying] = useState(false);
  const [deleting, setDeleting] = useState<Comment | null>(null);
  const create = useCreateCommentMutation(ctx.projectId, ctx.nodeId, { optimistic: false });
  const resolve = useResolveCommentMutation(ctx.projectId, ctx.nodeId);
  const remove = useDeleteCommentMutation(ctx.projectId, ctx.nodeId);
  const resolved = thread.status === 'resolved';
  const messages = [thread.root, ...thread.replies];
  const rootPending = isPending(thread.root);

  function failed(action: string) {
    return (error: unknown) => toast.error(`Could not ${action}: ${problemMessage(error)}`);
  }

  function requestDelete(comment: Comment) {
    // Deleting a root drops everyone's replies with it, and there is no undo: always confirm it.
    if (comment.id === thread.root.id) setDeleting(comment);
    else remove.mutate(comment.id, { onError: failed('delete the reply') });
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-3" aria-label="Messages">
        {messages.map((message) => (
          <Message
            key={message.id}
            comment={message}
            own={ctx.currentUserId !== null && message.authorId === ctx.currentUserId}
            ctx={ctx}
            onDelete={requestDelete}
          />
        ))}
      </ul>

      {replying ? (
        <CommentComposer
          label="Reply"
          placeholder="Reply…"
          submitLabel="Reply"
          onCancel={() => {
            setReplying(false);
            ctx.restoreEditorFocus();
          }}
          onSubmit={async (text) => {
            await create.mutateAsync({ bodyMarkdown: text, parentId: thread.root.id });
            setReplying(false);
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={rootPending}
            onClick={() => setReplying(true)}
          >
            Reply
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={rootPending || resolve.isPending}
            onClick={() =>
              resolve.mutate(
                { commentId: thread.root.id, resolved: !resolved },
                { onError: failed(resolved ? 'reopen the thread' : 'resolve the thread') },
              )
            }
          >
            {resolved ? <RotateCcw /> : <CheckCheck />}
            {resolved ? 'Reopen' : 'Resolve'}
          </Button>
          {ctx.copilotActions ? (
            <Button type="button" variant="outline" size="xs">
              <Sparkles />
              Send to Copilot
            </Button>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
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
        }}
      />
    </div>
  );
}
