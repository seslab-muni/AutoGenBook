import { useMemo, useState } from 'react';
import { AlertTriangle, Search } from 'lucide-react';

import type { OutlineNode, Source, SourceType } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SourceTypeTile } from '@/features/sources/components/source-type-tile';
import { SOURCE_TYPE_LABELS } from '@/features/sources/lib/source-format';
import { SOURCE_STATUS_PRESENTATION } from '@/features/sources/lib/source-status';
import { cn } from '@/lib/utils';

interface SourceScopePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: Pick<OutlineNode, 'sectionNumber' | 'title'>;
  sources: readonly Source[];
  /** Pre-checked source ids each time the dialog opens. */
  initialSelectedIds: readonly string[];
  pending?: boolean;
  onApply: (sourceIds: string[]) => void;
}

function sumChunks(sources: readonly Source[]): number {
  return sources.reduce((sum, source) => sum + (source.chunksCount ?? 0), 0);
}

/**
 * "Choose sources" dialog behind a node's "Only selected" source scope (issue #138) — not to be
 * confused with `SourcePicker`, the new-project wizard's upload step. Presentational: the caller
 * owns the PATCH (`useNodeSourceScope.applySelection`) and closes the dialog on success.
 */
export function SourceScopePicker({ open, onOpenChange, ...props }: SourceScopePickerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-4rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        {/* Mounted only while open, so each open starts from `initialSelectedIds` and a blank search. */}
        {open ? <PickerBody onCancel={() => onOpenChange(false)} {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PickerBody({
  node,
  sources,
  initialSelectedIds,
  pending = false,
  onApply,
  onCancel,
}: Omit<SourceScopePickerProps, 'open' | 'onOpenChange'> & { onCancel: () => void }) {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<SourceType | 'all'>('all');
  // Ids no longer attached to the project can't be applied (the API 422s them), so drop them.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(initialSelectedIds.filter((id) => sources.some((source) => source.id === id))),
  );

  const types = useMemo(
    () => [...new Set(sources.map((source) => source.type))].sort((a, b) => a.localeCompare(b)),
    [sources],
  );
  const needle = search.trim().toLowerCase();
  const shown = sources.filter(
    (source) =>
      (typeFilter === 'all' || source.type === typeFilter) &&
      (!needle ||
        source.name.toLowerCase().includes(needle) ||
        (source.authors?.toLowerCase().includes(needle) ?? false) ||
        (source.description?.toLowerCase().includes(needle) ?? false)),
  );
  const selected = sources.filter((source) => selectedIds.has(source.id));
  const unindexed = selected.filter((source) => source.status !== 'indexed');
  const totalChunks = sumChunks(sources);
  const selectedChunks = sumChunks(selected);

  function toggle(id: string, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function selectAllShown() {
    setSelectedIds((current) => new Set([...current, ...shown.map((source) => source.id)]));
  }

  let chunkLabel: string;
  if (selected.length === 0) {
    chunkLabel = 'Choose at least one, or switch back to "All project sources".';
  } else if (totalChunks > 0) {
    chunkLabel = `${selectedChunks.toLocaleString()} of ${totalChunks.toLocaleString()} indexed chunks · only these are searched`;
  } else {
    chunkLabel = 'Only these are searched';
  }

  return (
    <>
      <DialogHeader className="gap-1 px-5 pt-5 pb-3">
        <DialogTitle>Choose sources</DialogTitle>
        <DialogDescription>
          For{' '}
          <span className="font-semibold text-foreground">
            §{node.sectionNumber} {node.title}
          </span>
          . Its sections inherit this selection unless they set their own.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2.5 border-b px-5 pb-3">
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name, author, or description…"
            className="h-8 pl-8 text-xs"
            aria-label="Search sources"
          />
        </div>
        {types.length > 1 ? (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by type">
            {(['all', ...types] as const).map((type) => (
              <Button
                key={type}
                type="button"
                size="xs"
                variant={typeFilter === type ? 'default' : 'outline'}
                className="rounded-full"
                aria-pressed={typeFilter === type}
                onClick={() => setTypeFilter(type)}
              >
                {type === 'all' ? 'All types' : SOURCE_TYPE_LABELS[type]}
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2 border-b bg-muted/30 px-5 py-1.5 text-[11px] text-muted-foreground">
        <span className="mr-auto">
          Showing {shown.length} of {sources.length}
        </span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={shown.length === 0}
          onClick={selectAllShown}
        >
          Select all shown
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={selectedIds.size === 0}
          onClick={() => setSelectedIds(new Set())}
        >
          Clear
        </Button>
      </div>

      <ul className="custom-scrollbar min-h-0 flex-1 overflow-y-auto" aria-label="Sources">
        {shown.length === 0 ? (
          <li className="px-5 py-6 text-center text-xs text-muted-foreground">
            {sources.length === 0
              ? 'This project has no sources yet.'
              : 'Nothing matches the current search and filter.'}
          </li>
        ) : (
          shown.map((source) => {
            const checked = selectedIds.has(source.id);
            const presentation = SOURCE_STATUS_PRESENTATION[source.status];
            const statusLabel =
              source.status === 'indexed' && source.chunksCount != null
                ? `${source.chunksCount} chunks`
                : presentation.label;
            const inputId = `scope-source-${source.id}`;
            return (
              <li
                key={source.id}
                data-selected={checked || undefined}
                className="border-b last:border-b-0 data-selected:bg-accent/40"
              >
                <label
                  htmlFor={inputId}
                  className="flex cursor-pointer items-center gap-3 px-5 py-2 hover:bg-muted/30"
                >
                  <Checkbox
                    id={inputId}
                    checked={checked}
                    onCheckedChange={(next) => toggle(source.id, next === true)}
                    aria-label={source.name}
                  />
                  <SourceTypeTile type={source.type} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-foreground">
                      {source.name}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {source.authors
                        ? `${source.authors}${source.year ? ` (${source.year})` : ''}`
                        : '—'}
                    </span>
                  </span>
                  <span
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium',
                      presentation.textClassName,
                    )}
                  >
                    <span
                      className={cn('size-1.5 shrink-0 rounded-full', presentation.dotClassName)}
                    />
                    {statusLabel}
                  </span>
                </label>
              </li>
            );
          })
        )}
      </ul>

      {unindexed.length > 0 ? (
        <div className="flex items-start gap-2 border-t bg-warning/10 px-5 py-2 text-[11px] text-foreground">
          <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" />
          <span>
            {unindexed.length === 1
              ? '1 selected source is not indexed yet. It will be searched from the next run on.'
              : `${unindexed.length} selected sources are not indexed yet. They will be searched from the next run on.`}
          </span>
        </div>
      ) : null}

      <DialogFooter className="items-center border-t px-5 py-3 sm:justify-between">
        <div className="min-w-0 text-left">
          <p className="text-xs font-semibold text-foreground">
            {selected.length === 0
              ? 'Nothing selected'
              : `${selected.length} ${selected.length === 1 ? 'source' : 'sources'} selected`}
          </p>
          <p className="text-[11px] text-muted-foreground">{chunkLabel}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={selected.length === 0 || pending}
            onClick={() => onApply(selected.map((source) => source.id))}
          >
            Apply to §{node.sectionNumber}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
