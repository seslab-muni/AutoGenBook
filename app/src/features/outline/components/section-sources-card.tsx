import { Database } from 'lucide-react';

import type { OutlineNode } from '@/api/types';
import { SourceScopeControl } from '@/features/outline/components/source-scope-control';
import { useNodeSourceScope } from '@/features/outline/hooks/use-node-source-scope';
import { SourceScopePicker } from '@/features/sources/components/source-scope-picker';
import { SourceTypeTile } from '@/features/sources/components/source-type-tile';
import { cn } from '@/lib/utils';

interface SectionSourcesCardProps {
  projectId: string;
  node: OutlineNode;
  flat: readonly OutlineNode[];
}

/**
 * Compact "Sources for this section" card for the copilot panel (issue #138) — the same scope
 * control as the properties sheet's Sources section, plus chips of the sources the section
 * effectively retrieves from (dashed when inherited from an ancestor).
 */
export function SectionSourcesCard({ projectId, node, flat }: SectionSourcesCardProps) {
  const scope = useNodeSourceScope(projectId, node, flat);
  const inherited = !scope.effective.own;

  return (
    <div className="space-y-2 rounded-xl border p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-bold text-foreground">
        <Database className="size-3.5 text-muted-foreground" />
        Sources for this section
      </p>
      <SourceScopeControl
        aria-label="Section source scope"
        options={scope.options}
        value={scope.value}
        onChange={scope.choose}
      />
      {scope.effectiveSources.length > 0 ? (
        <ul className="flex flex-wrap gap-1" aria-label="Effective sources">
          {scope.effectiveSources.map((source) => (
            <li
              key={source.id}
              title={source.name}
              className={cn(
                'inline-flex max-w-40 items-center gap-1 rounded-md border py-0.5 pr-1.5 pl-0.5 text-[10px] font-medium',
                inherited
                  ? 'border-dashed text-muted-foreground'
                  : 'border-primary/30 bg-primary/5 text-foreground',
              )}
            >
              <SourceTypeTile type={source.type} className="size-4 rounded text-[6px]" />
              <span className="truncate">{source.name}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {!scope.isTopLevel ? (
        <p className="text-[10px] text-muted-foreground">
          Changing this saves an override on this section only.
        </p>
      ) : null}
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
