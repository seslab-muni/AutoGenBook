import { ClipboardCheck } from 'lucide-react';

import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { LazyMarkdownView } from '@/features/editor/components/markdown-view-lazy';

interface ReviewPanelProps {
  reviewerScore: number | null | undefined;
  reviewerNotes: string | null | undefined;
}

/**
 * The Copilot drawer's Review tab: the selected node's `reviewerScore` +
 * `reviewerNotes` (`section_reviews/<key>.json`, surfaced on `OutlineNode`),
 * rendered as Markdown since reviewer notes are LLM prose, not plain text.
 */
export function ReviewPanel({ reviewerScore, reviewerNotes }: ReviewPanelProps) {
  if (!reviewerNotes) {
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="No review for this section"
        description="Run the reviewer to get a score and notes for this section."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3 overflow-auto p-3">
      {reviewerScore != null ? (
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Score</span>
          <Badge variant={reviewerScore >= 7 ? 'default' : 'secondary'} className="font-mono">
            {reviewerScore.toFixed(1)} / 10
          </Badge>
        </div>
      ) : null}
      <LazyMarkdownView markdown={reviewerNotes} className="text-xs" />
    </div>
  );
}
