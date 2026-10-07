import { useCallback } from 'react';

import { useCreateCommentMutation } from '@/api/queries/comments';
import { cn } from '@/lib/utils';
import { CommentComposer } from './comment-composer';
import type { DraftCardProps } from './composer-registry';
import { DRAFT_ID, draftKey, useMarginStore } from './margin-store';

/**
 * The new-comment composer as a card: positioned at its selection (or pinned for a whole-section
 * comment), closed only once the server has accepted the text. The text survives the card
 * unmounting (a narrow screen's side sheet closing, switching the right pane) in the margin store.
 */
export function CommentDraftCard({ draft, ctx, top, register, quote }: DraftCardProps) {
  const closeComposer = useMarginStore((state) => state.closeComposer);
  const focus = useMarginStore((state) => state.focus);
  const create = useCreateCommentMutation(ctx.projectId, ctx.nodeId, { optimistic: false });
  const ref = useCallback((element: HTMLElement | null) => register(DRAFT_ID, element), [register]);
  const stored = useMarginStore((state) => state.drafts[draftKey(ctx.nodeId, 'new')]);

  return (
    <section
      ref={ref}
      aria-label="New comment"
      data-kind="draft"
      data-focused
      className={cn(
        '@container absolute inset-x-3 rounded-lg border border-ring bg-card p-3 text-card-foreground shadow-md',
        top === undefined && 'invisible',
      )}
      style={{ top: top ?? 0 }}
    >
      {quote ? (
        <blockquote className="mb-2 line-clamp-3 border-l-2 pl-2 text-xs text-muted-foreground italic">
          {quote}
        </blockquote>
      ) : (
        <p className="mb-2 text-xs text-muted-foreground">On the whole section</p>
      )}
      <CommentComposer
        label="New comment"
        draftKey={draftKey(ctx.nodeId, 'new')}
        initialValue={stored ?? ''}
        onCancel={() => {
          closeComposer();
          ctx.restoreEditorFocus();
        }}
        onSubmit={async (text) => {
          const comment = await create.mutateAsync({ bodyMarkdown: text, anchor: draft.anchor });
          closeComposer();
          focus(comment.id);
          ctx.restoreEditorFocus();
        }}
      />
    </section>
  );
}
