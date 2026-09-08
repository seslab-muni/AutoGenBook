import { FileText, Sparkles } from 'lucide-react';

import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import type { RagCitation } from '@/features/editor/lib/rag-citation';

interface CitationsPanelProps {
  citations: readonly RagCitation[] | undefined;
  /** Jumps to the source card for `sourceDoc` (#18's Sources pane) — omit to render non-interactive rows. */
  onOpenSource?: (sourceDoc: string) => void;
}

/**
 * The Copilot drawer's Citations tab: the selected node's `ragCitations`,
 * sorted by `relevanceScore` (highest first) — real node data, no fetch of
 * its own (the node is already loaded for the editor pane).
 */
export function CitationsPanel({ citations, onOpenSource }: CitationsPanelProps) {
  if (!citations || citations.length === 0) {
    return (
      <EmptyState
        icon={Sparkles}
        title="No citations yet"
        description="Citations this section's content was generated or edited against will show up here."
      />
    );
  }

  const sorted = [...citations].sort((a, b) => b.relevanceScore - a.relevanceScore);

  return (
    <ul className="flex flex-col gap-2 overflow-auto p-3">
      {sorted.map((citation) => (
        <li key={citation.id} className="rounded-lg border bg-card p-2.5 text-xs">
          <div className="flex items-start justify-between gap-2">
            <button
              type="button"
              disabled={!onOpenSource}
              onClick={onOpenSource ? () => onOpenSource(citation.sourceDoc) : undefined}
              className="flex min-w-0 items-center gap-1.5 truncate font-medium text-foreground hover:text-primary disabled:cursor-default disabled:hover:text-foreground"
              title={citation.sourceDoc}
            >
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{citation.authorYear ?? citation.sourceDoc}</span>
            </button>
            <Badge variant="secondary" className="shrink-0 font-mono">
              {Math.round(citation.relevanceScore * 100)}%
            </Badge>
          </div>
          <p className="mt-1.5 line-clamp-3 text-muted-foreground italic">
            "{citation.sectionSnippet}"
          </p>
          {citation.pageNumber != null ? (
            <p className="mt-1 text-[11px] text-muted-foreground">p. {citation.pageNumber}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
