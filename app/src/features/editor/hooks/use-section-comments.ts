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
import type { AnchorInput, TextRange } from '@/features/editor/lib/anchors';
import { normalizeEol } from '@/features/editor/lib/eol';
import type { CommentAnchor } from '@/api/types';

/** A located range in the text (UTF-16 offsets). `kind` picks the colour; `hidden` ones are tracked but not drawn. */
export interface SectionHighlight {
  id: string;
  kind: string;
  start: number;
  end: number;
  hidden: boolean;
}

const eolAnchors = new WeakMap<object, AnchorInput>();

/**
 * The anchor as the editor sees it: CodeMirror (and so the draft) counts LF line endings only, so a
 * quote or context taken from CR LF content is normalised. Identity is kept for anchors that have
 * no CR, and cached for those that do, so `useAnchorPositions` still sees unchanged anchors.
 */
function eolAnchor(anchor: CommentAnchor | null): AnchorInput | null {
  if (!anchor) return null;
  const text = `${anchor.quote ?? ''}${anchor.prefix ?? ''}${anchor.suffix ?? ''}`;
  if (!text.includes('\r')) return anchor as AnchorInput;
  let cached = eolAnchors.get(anchor);
  if (!cached) {
    cached = {
      quote: normalizeEol(anchor.quote ?? ''),
      prefix: normalizeEol(anchor.prefix ?? ''),
      suffix: normalizeEol(anchor.suffix ?? ''),
      // Offsets over CR LF text do not apply to the LF draft; the quote and its context find the spot.
      start: null,
      end: null,
    };
    eolAnchors.set(anchor, cached);
  }
  return cached;
}

/** Returns an equal value with a stable identity, so identical highlights never re-render the text. */
function useStable<T>(value: T): T {
  const json = JSON.stringify(value);
  return useMemo(() => JSON.parse(json) as T, [json]);
}

interface Options {
  /** Bumped when the text was replaced from outside. */
  resetKey: number;
  /** False for LaTeX-only sections: the server anchors against Markdown, so nothing is located. */
  anchorsEnabled: boolean;
}

/**
 * One section's margin data: the threads from the API, where each sits in the live `text`
 * (`useAnchorPositions`), what the margin filter lets through, and the highlights to draw in
 * whichever view is showing.
 */
export function useSectionComments(
  projectId: string,
  nodeId: string,
  text: string,
  { resetKey, anchorsEnabled }: Options,
) {
  const query = useQuery(comments.forNode(projectId, nodeId));
  const filter = useMarginStore((state) => state.filter);
  const showResolved = useMarginStore((state) => state.showResolved);
  const composer = useMarginStore((state) => state.composer);

  const rows = query.data?.items;
  const groups = useMemo(() => groupThreads(rows ?? []), [rows]);
  const draftAnchor = composer?.anchor ?? null;
  const items = useMemo<AnchorItem[]>(
    () => [
      ...(anchorsEnabled
        ? groups.map(([root]) => ({ id: root!.id, anchor: eolAnchor(root!.anchor) }))
        : []),
      ...(anchorsEnabled && draftAnchor ? [{ id: DRAFT_ID, anchor: draftAnchor }] : []),
    ],
    [groups, draftAnchor, anchorsEnabled],
  );
  const { positions, pending, reportMapped } = useAnchorPositions(items, text, { resetKey });

  const threads = useMemo<MarginThread[]>(
    () =>
      groups.map(([root, ...replies]) => {
        const sectionLevel = root!.anchor === null;
        const range = sectionLevel ? null : (positions.get(root!.id) ?? null);
        const waiting = !sectionLevel && range === null && pending.has(root!.id);
        return {
          id: root!.id,
          kind: root!.kind,
          root: root!,
          replies,
          status: root!.status,
          range,
          orphaned: anchorsEnabled && !sectionLevel && range === null && !waiting,
          pending: waiting,
          sectionLevel,
          quote: range ? text.slice(range.start, range.end) : (root!.anchor?.quote ?? ''),
        };
      }),
    [groups, positions, pending, text, anchorsEnabled],
  );

  const visible = useMemo(
    () => filterThreads(threads, filter, showResolved).sort(compareThreads),
    [threads, filter, showResolved],
  );

  const visibleIds = useMemo(() => new Set(visible.map((thread) => thread.id)), [visible]);
  const highlights = useStable<SectionHighlight[]>([
    ...threads.flatMap((thread) =>
      thread.range
        ? [
            {
              id: thread.id,
              kind: isClosed(thread) ? 'resolved' : thread.kind,
              start: thread.range.start,
              end: thread.range.end,
              hidden: !visibleIds.has(thread.id),
            },
          ]
        : [],
    ),
    ...((): SectionHighlight[] => {
      const range: TextRange | null = positions.get(DRAFT_ID) ?? null;
      return composer && range
        ? [{ id: DRAFT_ID, kind: 'draft', start: range.start, end: range.end, hidden: false }]
        : [];
    })(),
  ]);

  return {
    threads,
    visible,
    highlights,
    composer,
    composerRange: (positions.get(DRAFT_ID) ?? null) as TextRange | null,
    composerQuote: draftAnchor?.quote ?? '',
    reportMapped,
    loading: query.isPending,
    error: query.isError,
    retry: () => void query.refetch(),
  };
}
