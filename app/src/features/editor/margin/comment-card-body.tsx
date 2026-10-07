import { useState } from 'react';
import { CheckCheck, Pencil, RotateCcw, Sparkles, Trash2 } from 'lucide-react';

import type { Comment } from '@/api/types';
import {
  useCreateCommentMutation,
  useDeleteCommentMutation,
  useResolveCommentMutation,
  useUpdateCommentMutation,
} from '@/api/queries/comments';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { formatRelativeTime } from '@/features/runs/lib/run-format';
import type { MarginCardBodyProps } from './card-registry';
import { CommentComposer } from './comment-composer';
import { CommentMarkdown } from './comment-markdown';

function Message({
  comment,
  own,
  ctx,
  onDelete,
}: {
  comment: Comment;
  own: boolean;
  ctx: MarginCardBodyProps['ctx'];
  onDelete: (comment: Comment) => void;
}) {
  const [editing, setEditing] = useState(false);
  const update = useUpdateCommentMutation(ctx.projectId, ctx.nodeId);
  const author = comment.authorName ?? 'Someone';
  const relative = formatRelativeTime(comment.createdAt);
  const pending = comment.id.startsWith('optimistic-');

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
          busy={update.isPending}
          onCancel={() => {
            setEditing(false);
            ctx.restoreEditorFocus();
          }}
          onSubmit={(text) => {
            if (text !== comment.bodyMarkdown) {
              update.mutate({ commentId: comment.id, bodyMarkdown: text });
            }
            setEditing(false);
          }}
        />
      ) : (
        <>
          <CommentMarkdown>{comment.bodyMarkdown}</CommentMarkdown>
          {own && !pending ? (
            <div className="flex gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Edit comment by ${author}`}
                onClick={() => setEditing(true)}
              >
                <Pencil />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Delete comment by ${author}`}
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
 * Reopen, and Edit / Delete on the user's own messages. `Send to Copilot` waits for phase 4
 * (`ctx.copilotActions`).
 */
export function CommentCardBody({ thread, ctx }: MarginCardBodyProps) {
  const [replying, setReplying] = useState(false);
  const [deleting, setDeleting] = useState<Comment | null>(null);
  const create = useCreateCommentMutation(ctx.projectId, ctx.nodeId);
  const resolve = useResolveCommentMutation(ctx.projectId, ctx.nodeId);
  const remove = useDeleteCommentMutation(ctx.projectId, ctx.nodeId);
  const resolved = thread.status === 'resolved';
  const messages = [thread.root, ...thread.replies];

  function requestDelete(comment: Comment) {
    // Deleting a reply is cheap to redo; deleting the root drops everyone's replies with it.
    if (comment.id === thread.root.id && thread.replies.length > 0) setDeleting(comment);
    else remove.mutate(comment.id);
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
          busy={create.isPending}
          onCancel={() => {
            setReplying(false);
            ctx.restoreEditorFocus();
          }}
          onSubmit={(text) => {
            create.mutate({ bodyMarkdown: text, parentId: thread.root.id });
            setReplying(false);
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="button" variant="outline" size="xs" onClick={() => setReplying(true)}>
            Reply
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => resolve.mutate({ commentId: thread.root.id, resolved: !resolved })}
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
        title="Delete this thread?"
        description={`This also deletes ${thread.replies.length} ${thread.replies.length === 1 ? 'reply' : 'replies'}.`}
        confirmLabel="Delete thread"
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
          setDeleting(null);
        }}
      />
    </div>
  );
}
