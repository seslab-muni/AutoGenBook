import { Badge } from '@/components/ui/badge';
import { CommentMarkdown } from './comment-markdown';
import type { MarginCardPartProps } from './card-registry';

/** Minimal card for kinds the margin cannot act on yet (suggestions, review issues): text and status only. */
export function ReadOnlyCardBody({ thread }: MarginCardPartProps) {
  return (
    <div className="flex flex-col gap-2">
      <Badge variant="outline" className="capitalize">
        {thread.status}
      </Badge>
      {thread.root.bodyMarkdown ? (
        <CommentMarkdown>{thread.root.bodyMarkdown}</CommentMarkdown>
      ) : null}
    </div>
  );
}
