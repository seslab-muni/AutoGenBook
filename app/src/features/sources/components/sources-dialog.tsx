import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Database, Search, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

import {
  sources as sourcesQueries,
  useAddSourceMutation,
  useRemoveSourceMutation,
} from '@/api/queries/sources';
import { ApiError } from '@/api/client';
import type { Source, SourceStatus, SourceType } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { SourceEditDialog } from '@/features/sources/components/source-edit-dialog';
import { SourceRow } from '@/features/sources/components/source-row';
import { UploadDropzone } from '@/features/sources/components/upload-dropzone';
import { useSourceCitationCounts } from '@/features/sources/hooks/use-source-citation-counts';
import { formatBytes, SOURCE_TYPE_LABELS } from '@/features/sources/lib/source-format';
import { SOURCE_STATUS_PRESENTATION } from '@/features/sources/lib/source-status';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/ui-store';

type SortKey = 'name' | 'date' | 'size';
type SortDirection = 'asc' | 'desc';
interface SortState {
  key: SortKey;
  direction: SortDirection;
}

/** The direction a column starts in when first clicked: names A→Z, sizes and dates largest/newest first. */
const DEFAULT_SORT_DIRECTION: Record<SortKey, SortDirection> = {
  name: 'asc',
  date: 'desc',
  size: 'desc',
};

const STATUS_ORDER: SourceStatus[] = ['indexed', 'ready', 'error'];

function compareSources(a: Source, b: Source, key: SortKey): number {
  if (key === 'name') return a.name.localeCompare(b.name);
  if (key === 'size') return a.sizeBytes - b.sizeBytes;
  return new Date(a.uploadDate).getTime() - new Date(b.uploadDate).getTime();
}

function sortSources(items: Source[], sort: SortState): Source[] {
  const sorted = [...items];
  const sign = sort.direction === 'asc' ? 1 : -1;
  sorted.sort((a, b) => sign * compareSources(a, b, sort.key));
  return sorted;
}

function countBy<K extends string>(items: Source[], keyOf: (source: Source) => K): Map<K, number> {
  const counts = new Map<K, number>();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

interface RailFilterProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}

/** One row of the rail's Type / Status filter lists — label left, count right. */
function RailFilter({ label, count, active, onClick }: RailFilterProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors',
        active
          ? 'bg-muted font-semibold text-foreground'
          : 'font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground',
      )}
    >
      <span className="truncate">{label}</span>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{count}</span>
    </button>
  );
}

function RailGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="px-2.5 pb-1 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
        {title}
      </p>
      {children}
    </div>
  );
}

interface SortHeaderProps {
  label: string;
  column: SortKey;
  sort: SortState;
  onSort: (column: SortKey) => void;
  align?: 'left' | 'right';
}

function SortHeader({ label, column, sort, onSort, align = 'left' }: SortHeaderProps) {
  const active = sort.key === column;
  const Arrow = sort.direction === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn('py-2 pr-3 font-semibold', align === 'right' && 'text-right')}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          'inline-flex items-center gap-1 rounded-sm hover:text-foreground',
          active && 'text-foreground',
          align === 'right' && 'flex-row-reverse',
        )}
      >
        {label}
        <Arrow className={cn('size-3', !active && 'invisible')} aria-hidden="true" />
      </button>
    </th>
  );
}

interface SourcesDialogProps {
  projectId: string;
  /** Test seam, forwarded to `UploadDropzone` — see `api/upload.ts`. */
  createXhr?: () => XMLHttpRequest;
}

/**
 * Mounted in the project layout (`p.$projectId.tsx`); `AppHeader`'s Sources action opens it.
 *
 * Near-fullscreen: a fixed rail on the left (upload, then Type/Status filters with counts) and a
 * sticky-header table on the right that shows a dozen-plus sources at once. The earlier 896px
 * version spent its top 40% on the upload zone and toolbar, leaving ~2 rows of cards for
 * projects with 20+ sources.
 */
export function SourcesDialog({ projectId, createXhr }: SourcesDialogProps) {
  const activeModal = useUiStore((state) => state.activeModal);
  const closeModal = useUiStore((state) => state.closeModal);
  const open = activeModal === 'sources';

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<SourceType | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<SourceStatus | 'all'>('all');
  const [sort, setSort] = useState<SortState>({ key: 'date', direction: 'desc' });
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [editingSource, setEditingSource] = useState<Source | null>(null);
  const [detachingSource, setDetachingSource] = useState<Source | null>(null);
  const [bulkDetachOpen, setBulkDetachOpen] = useState(false);

  const { data, isPending } = useQuery({ ...sourcesQueries.list(projectId), enabled: open });
  const citationCounts = useSourceCitationCounts(projectId);
  const addMutation = useAddSourceMutation(projectId);
  const removeMutation = useRemoveSourceMutation(projectId);

  const allSources = useMemo(() => data?.items ?? [], [data]);
  const typeCounts = useMemo(() => countBy(allSources, (source) => source.type), [allSources]);
  const statusCounts = useMemo(() => countBy(allSources, (source) => source.status), [allSources]);
  const availableTypes = useMemo(
    () => [...typeCounts.keys()].sort((a, b) => a.localeCompare(b)),
    [typeCounts],
  );
  const totalBytes = useMemo(
    () => allSources.reduce((sum, source) => sum + source.sizeBytes, 0),
    [allSources],
  );

  const filtered = sortSources(
    allSources.filter((source) => {
      const matchesType = typeFilter === 'all' || source.type === typeFilter;
      const matchesStatus = statusFilter === 'all' || source.status === statusFilter;
      const needle = search.trim().toLowerCase();
      const matchesSearch =
        !needle ||
        source.name.toLowerCase().includes(needle) ||
        (source.authors?.toLowerCase().includes(needle) ?? false) ||
        (source.description?.toLowerCase().includes(needle) ?? false);
      return matchesType && matchesStatus && matchesSearch;
    }),
    sort,
  );

  // Selection is only meaningful against sources that still exist (a detach or a filter change
  // must not leave phantom ids counted in "N selected").
  const selectedVisible = filtered.filter((source) => selectedIds.has(source.id));
  const allVisibleSelected = filtered.length > 0 && selectedVisible.length === filtered.length;
  const headerChecked: boolean | 'indeterminate' = allVisibleSelected
    ? true
    : selectedVisible.length > 0
      ? 'indeterminate'
      : false;

  function toggleSort(column: SortKey) {
    setSort((current) =>
      current.key === column
        ? { key: column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key: column, direction: DEFAULT_SORT_DIRECTION[column] },
    );
  }

  function setSelected(id: string, selected: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) filtered.forEach((source) => next.delete(source.id));
      else filtered.forEach((source) => next.add(source.id));
      return next;
    });
  }

  function handleUploaded(file: { id: string; kbEligible: boolean }) {
    if (!file.kbEligible) return;
    addMutation.mutate(
      { fileId: file.id },
      {
        onError: (error) => {
          const title = error instanceof ApiError ? error.problem?.title : undefined;
          toast.error(title ?? 'Could not attach source');
        },
      },
    );
  }

  function handleDetach() {
    if (!detachingSource) return;
    const name = detachingSource.name;
    removeMutation.mutate(detachingSource.id, {
      onSuccess: () => {
        toast.success(`Detached "${name}"`);
        setDetachingSource(null);
        setSelected(detachingSource.id, false);
      },
    });
  }

  async function handleBulkDetach() {
    const targets = selectedVisible;
    const results = await Promise.allSettled(
      targets.map((source) => removeMutation.mutateAsync(source.id)),
    );
    const failed = results.filter((result) => result.status === 'rejected').length;
    const detached = targets.length - failed;
    if (detached > 0) {
      toast.success(`Detached ${detached} ${detached === 1 ? 'source' : 'sources'}`);
    }
    if (failed > 0) {
      toast.error(`Could not detach ${failed} ${failed === 1 ? 'source' : 'sources'}`);
    }
    setSelectedIds(new Set());
    setBulkDetachOpen(false);
  }

  let tableBody: React.ReactNode;
  if (isPending) {
    tableBody = (
      <div className="space-y-2 py-3">
        {['a', 'b', 'c', 'd', 'e', 'f'].map((key) => (
          <Skeleton key={key} className="h-9 w-full rounded-md" />
        ))}
      </div>
    );
  } else if (filtered.length === 0) {
    tableBody = (
      <EmptyState
        icon={Database}
        title={allSources.length === 0 ? 'No sources yet' : 'No matching sources'}
        description={
          allSources.length === 0
            ? "Upload PDFs, DOCX, PPTX, Markdown, or text files to build this project's knowledge base."
            : 'Nothing matches the current search and filters.'
        }
      />
    );
  } else {
    tableBody = (
      <table className="w-full table-fixed border-separate border-spacing-0 text-left">
        <colgroup>
          <col className="w-9" />
          <col className="w-auto" />
          <col className="w-52" />
          <col className="w-20" />
          <col className="w-28" />
          <col className="w-44" />
          <col className="w-14" />
          <col className="w-10" />
        </colgroup>
        <thead className="sticky top-0 z-10 bg-background text-[11px] text-muted-foreground">
          <tr className="[&>th]:border-b">
            <th scope="col" className="py-2 pr-1 pl-3">
              <Checkbox
                checked={headerChecked}
                onCheckedChange={toggleAllVisible}
                aria-label={allVisibleSelected ? 'Deselect all sources' : 'Select all sources'}
              />
            </th>
            <SortHeader label="Source" column="name" sort={sort} onSort={toggleSort} />
            <th scope="col" className="py-2 pr-3 font-semibold">
              Authors
            </th>
            <SortHeader label="Size" column="size" sort={sort} onSort={toggleSort} align="right" />
            <SortHeader label="Uploaded" column="date" sort={sort} onSort={toggleSort} />
            <th scope="col" className="py-2 pr-3 font-semibold">
              Status
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-semibold">
              Cites
            </th>
            <th scope="col" className="py-2 pr-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="[&>tr:last-child>td]:border-b-0 [&>tr>td]:border-b">
          {filtered.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              citationCount={citationCounts[source.name] ?? 0}
              selected={selectedIds.has(source.id)}
              onSelectedChange={(selected) => setSelected(source.id, selected)}
              onEdit={() => setEditingSource(source)}
              onDetach={() => setDetachingSource(source)}
            />
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && closeModal()}>
        <DialogContent className="flex h-[calc(100vh-4rem)] flex-row gap-0 overflow-hidden p-0 sm:max-w-[calc(100vw-4rem)]">
          <aside className="custom-scrollbar flex w-64 shrink-0 flex-col gap-5 overflow-y-auto border-r bg-card p-4">
            <DialogHeader className="gap-1">
              <DialogTitle className="flex items-center gap-2 text-base">
                <Database className="size-4" />
                Sources
              </DialogTitle>
              <DialogDescription className="text-xs">
                Files attached to this project as retrieval sources for the RAG knowledge base.
              </DialogDescription>
            </DialogHeader>

            <UploadDropzone
              compact
              onUploaded={handleUploaded}
              {...(createXhr ? { createXhr } : {})}
            />

            <RailGroup title="Type">
              <RailFilter
                label="All sources"
                count={allSources.length}
                active={typeFilter === 'all'}
                onClick={() => setTypeFilter('all')}
              />
              {availableTypes.map((type) => (
                <RailFilter
                  key={type}
                  label={SOURCE_TYPE_LABELS[type]}
                  count={typeCounts.get(type) ?? 0}
                  active={typeFilter === type}
                  onClick={() => setTypeFilter(type)}
                />
              ))}
            </RailGroup>

            <RailGroup title="Status">
              <RailFilter
                label="Any status"
                count={allSources.length}
                active={statusFilter === 'all'}
                onClick={() => setStatusFilter('all')}
              />
              {STATUS_ORDER.map((status) => (
                <RailFilter
                  key={status}
                  label={SOURCE_STATUS_PRESENTATION[status].label}
                  count={statusCounts.get(status) ?? 0}
                  active={statusFilter === status}
                  onClick={() => setStatusFilter(status)}
                />
              ))}
            </RailGroup>

            <p className="mt-auto px-2.5 text-[11px] text-muted-foreground">
              {formatBytes(totalBytes)} across {allSources.length}{' '}
              {allSources.length === 1 ? 'file' : 'files'}
            </p>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 px-6 pt-5 pr-14 pb-3">
              <div className="relative w-80 max-w-full">
                <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search by name, author, or description…"
                  className="h-8 pl-8 text-xs"
                  aria-label="Search sources"
                />
              </div>

              {selectedVisible.length > 0 ? (
                <div className="ml-auto flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {selectedVisible.length} selected
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setBulkDetachOpen(true)}
                  >
                    <Trash2 />
                    Detach
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Clear selection"
                    onClick={() => setSelectedIds(new Set())}
                  >
                    <X />
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="custom-scrollbar flex-1 overflow-y-auto px-6">{tableBody}</div>

            <div className="flex items-center justify-between border-t px-6 py-2.5 text-[11px] text-muted-foreground">
              <span>
                Showing {filtered.length} of {allSources.length}
              </span>
              <span>Select rows to detach several sources at once.</span>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <SourceEditDialog
        projectId={projectId}
        source={editingSource}
        onOpenChange={(next) => !next && setEditingSource(null)}
      />

      <ConfirmDialog
        open={detachingSource !== null}
        onOpenChange={(next) => !next && setDetachingSource(null)}
        title={`Detach "${detachingSource?.name}"?`}
        description="This removes the source from the project's knowledge base. The uploaded file stays in storage and can be re-attached later."
        confirmLabel="Detach"
        onConfirm={handleDetach}
      />

      <ConfirmDialog
        open={bulkDetachOpen}
        onOpenChange={setBulkDetachOpen}
        title={`Detach ${selectedVisible.length} ${selectedVisible.length === 1 ? 'source' : 'sources'}?`}
        description="This removes them from the project's knowledge base. The uploaded files stay in storage and can be re-attached later."
        confirmLabel="Detach"
        onConfirm={() => void handleBulkDetach()}
      />
    </>
  );
}
