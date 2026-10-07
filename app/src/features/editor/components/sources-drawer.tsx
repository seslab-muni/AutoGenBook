import { useEffect } from 'react';
import { Database } from 'lucide-react';

import type { Source } from '@/api/types';
import { Button } from '@/components/ui/button';
import type { RagCitation } from '@/features/editor/lib/rag-citation';
import type { EffectiveSourceScope } from '@/features/outline/source-scope';
import { SourceTypeTile } from '@/features/sources/components/source-type-tile';

interface SourcesDrawerProps {
  id: string;
  sources: readonly Source[];
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
 * section retrieves from, how often each is cited in the section, and a link into Chapter options
 * to change the scope. Not modal — the editor stays usable — so it closes on Escape or the
 * status bar button instead of trapping focus.
 */
export function SourcesDrawer({
  id,
  sources,
  scope,
  scopeFromLabel,
  citations,
  onChangeScope,
  onClose,
}: SourcesDrawerProps) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const citedBy = new Map<string, number>();
  for (const citation of citations) {
    citedBy.set(citation.sourceDoc, (citedBy.get(citation.sourceDoc) ?? 0) + 1);
  }

  return (
    <section
      id={id}
      aria-label="Sources for this section"
      className="absolute inset-x-0 bottom-8 z-10 flex max-h-64 flex-col gap-2 border-t bg-popover px-4 py-3 text-xs text-popover-foreground shadow-[0_-8px_20px_rgb(0_0_0/0.08)]"
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
      {sources.length === 0 ? (
        <p className="text-muted-foreground">
          No sources are attached to this project yet. Add some from Sources in the app bar.
        </p>
      ) : (
        <ul
          aria-label="Effective sources"
          className="custom-scrollbar grid min-h-0 grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2 overflow-y-auto"
        >
          {sources.map((source) => {
            const cited = citedBy.get(source.name) ?? 0;
            return (
              <li key={source.id} className="flex items-start gap-2 rounded-lg border p-2">
                <SourceTypeTile type={source.type} />
                <div className="min-w-0">
                  <div className="truncate font-medium" title={source.name}>
                    {source.name}
                  </div>
                  <div className="text-muted-foreground">
                    {source.chunksCount != null ? `${source.chunksCount} chunks · ` : null}
                    {cited > 0 ? `cited ${cited}× here` : 'not cited yet'}
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
