import { Database } from 'lucide-react';

import type { Source } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { RagCitation } from '@/features/editor/lib/rag-citation';
import type { EffectiveSourceScope } from '@/features/outline/source-scope';
import { SourceTypeTile } from '@/features/sources/components/source-type-tile';

interface SourcesDrawerProps {
  id: string;
  /** Sources the section can actually retrieve from. */
  sources: readonly Source[];
  /** In-scope sources whose indexing failed — listed, but not searched. */
  failedSources: readonly Source[];
  loading: boolean;
  scope: EffectiveSourceScope;
  /** The node the scope comes from, when it is an ancestor or the section itself. */
  scopeFromLabel: string | null;
  citations: readonly RagCitation[];
  onChangeScope: () => void;
  onClose: () => void;
}

function describeScope(scope: EffectiveSourceScope, from: string | null): string {
  if (scope.kind === 'all') return 'all project sources';
  if (scope.own) return 'selected on this section';
  return from ? `inherited from ${from}` : 'inherited';
}

/**
 * The drawer above the editor status bar (opened by its "N sources" button): the sources this
 * section retrieves from, how many passages of each the last run cited, and a link into Chapter
 * options to change the scope. Not modal — the editor stays usable — so it closes on Escape
 * pressed inside it, or via the status bar button, rather than trapping focus. It sits in the
 * pane's flex column, so the editor above it shrinks instead of being covered.
 */
export function SourcesDrawer({
  id,
  sources,
  failedSources,
  loading,
  scope,
  scopeFromLabel,
  citations,
  onChangeScope,
  onClose,
}: SourcesDrawerProps) {
  // `ragCitations` is what the last run recorded for this section (one entry per cited passage),
  // keyed by file name — not a live count of occurrences in the current text.
  const citedBy = new Map<string, number>();
  for (const citation of citations) {
    citedBy.set(citation.sourceDoc, (citedBy.get(citation.sourceDoc) ?? 0) + 1);
  }
  const empty = sources.length === 0 && failedSources.length === 0;

  return (
    <section
      id={id}
      aria-label="Sources for this section"
      className="flex max-h-64 shrink-0 flex-col gap-2 border-t bg-popover px-4 py-3 text-xs text-popover-foreground"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex shrink-0 items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 font-semibold">
          <Database className="size-3.5 text-muted-foreground" aria-hidden="true" />
          Sources for this section
        </span>
        <span className="flex items-center gap-2 text-muted-foreground">
          Scope: {describeScope(scope, scopeFromLabel)}
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto p-0"
            onClick={onChangeScope}
          >
            Change scope
          </Button>
        </span>
      </div>
      {loading ? (
        <p className="text-muted-foreground">Loading sources…</p>
      ) : empty ? (
        <p className="text-muted-foreground">
          No sources are attached to this project yet. Add some from Sources in the app bar.
        </p>
      ) : (
        <ul
          aria-label="Effective sources"
          className="custom-scrollbar grid min-h-0 grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2 overflow-y-auto"
        >
          {[...sources, ...failedSources].map((source) => {
            const failed = source.status === 'error';
            const cited = citedBy.get(source.name) ?? 0;
            return (
              <li key={source.id} className="flex items-start gap-2 rounded-lg border p-2">
                <SourceTypeTile type={source.type} />
                <div className="min-w-0">
                  <div className="truncate font-medium" title={source.name}>
                    {source.name}
                  </div>
                  <div className="text-muted-foreground">
                    {failed ? (
                      <Badge variant="destructive">Indexing failed, not searched</Badge>
                    ) : (
                      <>
                        {source.chunksCount != null ? `${source.chunksCount} chunks · ` : null}
                        {cited > 0
                          ? `${cited} ${cited === 1 ? 'passage' : 'passages'} cited (last run)`
                          : 'not cited in last run'}
                      </>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
