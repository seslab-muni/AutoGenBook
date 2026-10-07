import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { comments } from '@/api/queries/comments';
import { useAnchorPositions, type AnchorItem } from '@/features/editor/hooks/use-anchor-positions';
import { DRAFT_ID, useMarginStore } from '@/features/editor/margin/margin-store';
import {
  compareThreads,
  filterThreads,
  groupThreads,
  isClosed,
  type MarginThread,
} from '@/features/editor/margin/threads';
import type { TextRange } from '@/features/editor/lib/anchors';

/** A range to highlight in the text, in UTF-16 offsets. `kind` picks the colour. */
export interface SectionHighlight {
  id: string;
  kind: string;
  start: number;
  end: number;
}

/** Returns an equal value with a stable identity, so identical highlights never re-render the text. */
function useStable<T>(value: T): T {
  const json = JSON.stringify(value);
  return useMemo(() => JSON.parse(json) as T, [json]);
}

/**
 * One section's margin data: the threads from the API, where each sits in the live `text`
 * (`useAnchorPositions`), what the margin filter lets through, and the highlights to draw in
 * whichever view is showing.
 */
export function useSectionComments(projectId: string, nodeId: string, text: string) {
  const query = useQuery(comments.forNode(projectId, nodeId));
  const filter = useMarginStore((state) => state.filter);
  const showResolved = useMarginStore((state) => state.showResolved);
  const composer = useMarginStore((state) => state.composer);

  const rows = query.data?.items;
  const groups = useMemo(() => groupThreads(rows ?? []), [rows]);
  const items = useMemo<AnchorItem[]>(
    () => groups.map(([root]) => ({ id: root!.id, anchor: root!.anchor })),
    [groups],
  );
  const positions = useAnchorPositions(items, text);

  const draftItems = useMemo<AnchorItem[]>(
    () => (composer ? [{ id: DRAFT_ID, anchor: composer.anchor }] : []),
    [composer],
  );
  const draftPositions = useAnchorPositions(draftItems, text);
  const composerRange: TextRange | null = draftPositions.get(DRAFT_ID) ?? null;

  const threads = useMemo<MarginThread[]>(
    () =>
      groups.map(([root, ...replies]) => {
        const sectionLevel = root!.anchor === null;
        const range = sectionLevel ? null : (positions.get(root!.id) ?? null);
        return {
          id: root!.id,
          kind: root!.kind,
          root: root!,
          replies,
          status: root!.status,
          range,
          orphaned: !sectionLevel && range === null,
          sectionLevel,
          quote: range ? text.slice(range.start, range.end) : (root!.anchor?.quote ?? ''),
        };
      }),
    [groups, positions, text],
  );

  const visible = useMemo(
    () => filterThreads(threads, filter, showResolved).sort(compareThreads),
    [threads, filter, showResolved],
  );

  const highlights = useStable<SectionHighlight[]>([
    ...visible.flatMap((thread) =>
      thread.range
        ? [
            {
              id: thread.id,
              kind: isClosed(thread) ? 'resolved' : thread.kind,
              start: thread.range.start,
              end: thread.range.end,
            },
          ]
        : [],
    ),
    ...(composer && composerRange
      ? [{ id: DRAFT_ID, kind: 'draft', start: composerRange.start, end: composerRange.end }]
      : []),
  ]);

  return {
    threads,
    visible,
    highlights,
    composer,
    composerRange,
    composerQuote: composer?.anchor?.quote ?? '',
    loading: query.isPending,
    error: query.isError,
    retry: () => void query.refetch(),
  };
}
