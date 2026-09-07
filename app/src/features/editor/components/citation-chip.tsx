import { BookMarked } from 'lucide-react';

import type { RAGCitation } from '@/api/types';
import { cn } from '@/lib/utils';

interface CitationChipProps {
  citeKey: string;
  citation: RAGCitation | undefined;
  onClick: ((citeKey: string) => void) | undefined;
}

/**
 * Inline chip rendered for every `[@key]`/`\cite{key}` token
 * (`remarkCitations`). When a matching `RAGCitation` is found by id/citeKey
 * it shows `authorYear` (falling back to the source filename) and is
 * clickable, handing the key to `onClick` so `MarkdownView`'s caller can jump
 * to the Copilot drawer's Citations tab; otherwise it renders a muted
 * "unresolved" chip so a stale/typo'd key is still visible rather than
 * silently swallowed.
 */
export function CitationChip({ citeKey, citation, onClick }: CitationChipProps) {
  const label = citation?.authorYear ?? citation?.sourceDoc ?? citeKey;

  return (
    <button
      type="button"
      data-testid={`citation-chip-${citeKey}`}
      disabled={!onClick}
      onClick={onClick ? () => onClick(citeKey) : undefined}
      title={
        citation?.sectionSnippet ?? `Citation "${citeKey}" not found in this section's sources`
      }
      className={cn(
        'not-prose mx-0.5 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 align-baseline text-[11px] font-medium whitespace-nowrap',
        citation
          ? 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20'
          : 'cursor-default border-dashed border-muted-foreground/40 text-muted-foreground',
      )}
    >
      <BookMarked className="size-3" />
      {label}
    </button>
  );
}
