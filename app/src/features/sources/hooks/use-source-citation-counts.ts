import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { outline } from '@/api/queries/outline';
import { parseRagCitations } from '@/features/editor/lib/rag-citation';

/** Client-side, display-only: counts how many `ragCitations` across the outline point at each
 * source by matching `RagCitation.sourceDoc` to `Source.name` (there's no `sourceId` on a
 * citation — it's a free-text filename recorded at generation time). */
export function useSourceCitationCounts(projectId: string): Record<string, number> {
  const { data } = useQuery(outline.flat(projectId));

  return useMemo(() => {
    const counts: Record<string, number> = {};
    for (const node of data?.items ?? []) {
      for (const citation of parseRagCitations(node.ragCitations)) {
        counts[citation.sourceDoc] = (counts[citation.sourceDoc] ?? 0) + 1;
      }
    }
    return counts;
  }, [data]);
}
