import { Database, Info, Plus, X } from 'lucide-react';

import type { OutlineNode, Source } from '@/api/types';
import { Button } from '@/components/ui/button';
import { SourceScopeControl } from '@/features/outline/components/source-scope-control';
import { useNodeSourceScope } from '@/features/outline/hooks/use-node-source-scope';
import { formatSectionList, sourceScopeImpact } from '@/features/outline/source-scope';
import { SourceScopePicker } from '@/features/sources/components/source-scope-picker';
import { SourceTypeTile } from '@/features/sources/components/source-type-tile';

interface NodeSourcesSectionProps {
  projectId: string;
  node: OutlineNode;
  flat: readonly OutlineNode[];
}

function pluralSources(count: number): string {
  return `${count} ${count === 1 ? 'source' : 'sources'}`;
}

/** "Applies to §2.1 and §2.2. §2.3 has its own selection." — for a node with children. */
function impactSentence(node: OutlineNode, flat: readonly OutlineNode[]): string | null {
  const { inheriting, overriding } = sourceScopeImpact(node.id, flat);
  if (inheriting.length === 0 && overriding.length === 0) return null;
  const parts: string[] = [];
  if (inheriting.length > 0) parts.push(`Applies to ${formatSectionList(inheriting)}.`);
  const ownSelection = overriding.filter((item) => item.sourceScope === 'selected');
  const ownAll = overriding.filter((item) => item.sourceScope === 'all');
  if (ownSelection.length > 0) {
    parts.push(
      `${formatSectionList(ownSelection)} ${ownSelection.length === 1 ? 'has its' : 'have their'} own selection.`,
    );
  }
  if (ownAll.length > 0) {
    parts.push(
      `${formatSectionList(ownAll)} ${ownAll.length === 1 ? 'uses' : 'use'} all project sources.`,
    );
  }
  return parts.join(' ');
}

/**
 * The node properties sheet's "Sources" section (issue #138): which knowledge-base files this
 * node's leaf sections retrieve from — inherited from the nearest scoped ancestor, every project
 * source, or an explicit selection picked in `SourceScopePicker`.
 */
export function NodeSourcesSection({ projectId, node, flat }: NodeSourcesSectionProps) {
  const scope = useNodeSourceScope(projectId, node, flat);
  const ownSelection = node.sourceScope === 'selected';
  const inheritedCount =
    node.sourceScope === 'inherit' && scope.effective.kind === 'selected'
      ? scope.effective.sourceIds.length
      : 0;

  const pickedSources = ownSelection
    ? node.sourceIds.map((id) => ({ id, source: scope.sourcesById.get(id) }))
    : [];
  const totalChunks = scope.sources.reduce((sum, source) => sum + (source.chunksCount ?? 0), 0);
  const selectedChunks = scope.effectiveSources.reduce(
    (sum, source) => sum + (source.chunksCount ?? 0),
    0,
  );
  const coverage = totalChunks > 0 ? Math.round((selectedChunks / totalChunks) * 100) : 0;
  const impact = node.sourceScope !== 'inherit' ? impactSentence(node, flat) : null;

  return (
    <div className="space-y-2.5">
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Database className="size-3.5 text-muted-foreground" />
          Sources
        </div>
        <p className="text-[11px] text-muted-foreground">
          Which knowledge-base files this node&apos;s sections retrieve from while drafting.
        </p>
      </div>

      <SourceScopeControl
        aria-label="Source scope"
        options={scope.options}
        value={scope.value}
        onChange={scope.choose}
      />

      {inheritedCount > 0 && scope.effectiveFrom ? (
        <p className="text-[11px] text-muted-foreground">
          Uses the {pluralSources(inheritedCount)} selected on §{scope.effectiveFrom.sectionNumber}.
        </p>
      ) : null}

      {ownSelection ? (
        <div className="overflow-hidden rounded-lg border">
          <ul aria-label="Selected sources">
            {pickedSources.map(({ id, source }) => (
              <PickedSourceRow key={id} source={source} onRemove={() => scope.removeSource(id)} />
            ))}
          </ul>
          <div className="flex items-center gap-1 border-t bg-muted/30 px-1.5 py-1">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => scope.setPickerOpen(true)}
            >
              <Plus />
              Add sources
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="ml-auto text-muted-foreground"
              onClick={scope.clear}
            >
              Clear
            </Button>
          </div>
        </div>
      ) : null}

      {ownSelection && totalChunks > 0 ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Knowledge base coverage</span>
            <span className="font-mono">
              {selectedChunks.toLocaleString()} of {totalChunks.toLocaleString()} chunks ·{' '}
              {coverage}%
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${coverage}%` }} />
          </div>
        </div>
      ) : null}

      <div className="flex items-start gap-2 rounded-lg bg-muted/40 p-2.5 text-[11px] text-muted-foreground">
        <Info className="mt-px size-3.5 shrink-0" />
        <p>
          {impact ? `${impact} ` : null}Takes effect on the next run or regenerate — drafted text is
          not changed.
        </p>
      </div>

      <SourceScopePicker
        open={scope.pickerOpen}
        onOpenChange={scope.setPickerOpen}
        node={node}
        sources={scope.sources}
        initialSelectedIds={scope.initialPickerIds}
        pending={scope.isPending}
        onApply={scope.applySelection}
      />
    </div>
  );
}

function PickedSourceRow({
  source,
  onRemove,
}: {
  source: Source | undefined;
  onRemove: () => void;
}) {
  // A source id the list query hasn't returned (still loading, or past its page) — still
  // removable, just without its metadata.
  const name = source?.name ?? 'Unknown source';
  return (
    <li className="flex items-center gap-2.5 border-b px-2.5 py-1.5 last:border-b-0">
      {source ? <SourceTypeTile type={source.type} /> : null}
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={name}>
        {name}
      </span>
      {source?.chunksCount != null ? (
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {source.chunksCount} ch
        </span>
      ) : null}
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Remove ${name}`}
        onClick={onRemove}
      >
        <X />
      </Button>
    </li>
  );
}
