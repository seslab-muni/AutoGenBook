import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Database, LayoutGrid, List, Search } from 'lucide-react';
import { toast } from 'sonner';

import {
  sources as sourcesQueries,
  useAddSourceMutation,
  useRemoveSourceMutation,
} from '@/api/queries/sources';
import { ApiError } from '@/api/client';
import type { Source, SourceType } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { SourceCard } from '@/features/sources/components/source-card';
import { SourceEditDialog } from '@/features/sources/components/source-edit-dialog';
import { SourceRow } from '@/features/sources/components/source-row';
import { UploadDropzone } from '@/features/sources/components/upload-dropzone';
import { useSourceCitationCounts } from '@/features/sources/hooks/use-source-citation-counts';
import { SOURCE_TYPE_LABELS } from '@/features/sources/lib/source-format';
import { useUiStore } from '@/stores/ui-store';

type SortKey = 'name' | 'date' | 'size';
type ViewMode = 'grid' | 'list';

const SORT_LABELS: Record<SortKey, string> = { name: 'Name', date: 'Upload date', size: 'Size' };

function sortSources(items: Source[], sort: SortKey): Source[] {
  const sorted = [...items];
  sorted.sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'size') return b.sizeBytes - a.sizeBytes;
    return new Date(b.uploadDate).getTime() - new Date(a.uploadDate).getTime();
  });
  return sorted;
}

interface SourcesDialogProps {
  projectId: string;
  /** Test seam, forwarded to `UploadDropzone` — see `api/upload.ts`. */
  createXhr?: () => XMLHttpRequest;
}

/** Mounted in the project layout (`p.$projectId.tsx`); `AppHeader`'s Sources action opens it. */
export function SourcesDialog({ projectId, createXhr }: SourcesDialogProps) {
  const activeModal = useUiStore((state) => state.activeModal);
  const closeModal = useUiStore((state) => state.closeModal);
  const open = activeModal === 'sources';

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<SourceType | 'all'>('all');
  const [sort, setSort] = useState<SortKey>('date');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [editingSource, setEditingSource] = useState<Source | null>(null);
  const [detachingSource, setDetachingSource] = useState<Source | null>(null);

  const { data, isPending } = useQuery({ ...sourcesQueries.list(projectId), enabled: open });
  const citationCounts = useSourceCitationCounts(projectId);
  const addMutation = useAddSourceMutation(projectId);
  const removeMutation = useRemoveSourceMutation(projectId);

  const allSources = data?.items ?? [];
  const availableTypes = useMemo(
    () =>
      [...new Set((data?.items ?? []).map((source) => source.type))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [data],
  );

  const filtered = sortSources(
    allSources.filter((source) => {
      const matchesType = typeFilter === 'all' || source.type === typeFilter;
      const needle = search.trim().toLowerCase();
      const matchesSearch =
        !needle ||
        source.name.toLowerCase().includes(needle) ||
        (source.authors?.toLowerCase().includes(needle) ?? false) ||
        (source.description?.toLowerCase().includes(needle) ?? false);
      return matchesType && matchesSearch;
    }),
    sort,
  );

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
      },
    });
  }

  let sourcesBody: React.ReactNode;
  if (isPending) {
    sourcesBody = (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {['a', 'b', 'c'].map((key) => (
          <Skeleton key={key} className="h-28 w-full rounded-xl" />
        ))}
      </div>
    );
  } else if (filtered.length === 0) {
    sourcesBody = (
      <EmptyState
        icon={Database}
        title={allSources.length === 0 ? 'No sources yet' : 'No matching sources'}
        description={
          allSources.length === 0
            ? "Upload PDFs, DOCX, PPTX, Markdown, or text files above to build this project's knowledge base."
            : `Nothing matches "${search}".`
        }
      />
    );
  } else if (viewMode === 'grid') {
    sourcesBody = (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((source) => (
          <SourceCard
            key={source.id}
            source={source}
            citationCount={citationCounts[source.name] ?? 0}
            onEdit={() => setEditingSource(source)}
            onDetach={() => setDetachingSource(source)}
          />
        ))}
      </div>
    );
  } else {
    sourcesBody = (
      <table className="w-full table-fixed text-left">
        <colgroup>
          <col className="w-auto" />
          <col className="w-24" />
          <col className="w-20" />
          <col className="w-24" />
          <col className="w-36" />
          <col className="w-16" />
          <col className="w-12" />
        </colgroup>
        <thead className="text-[11px] font-semibold text-muted-foreground">
          <tr className="border-b">
            <th className="py-1.5 pl-3 font-semibold">Source</th>
            <th className="py-1.5 font-semibold">Type</th>
            <th className="py-1.5 font-semibold">Size</th>
            <th className="py-1.5 font-semibold">Uploaded</th>
            <th className="py-1.5 font-semibold">Status</th>
            <th className="py-1.5 font-semibold">Cites</th>
            <th className="py-1.5 pr-3 text-right font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              citationCount={citationCounts[source.name] ?? 0}
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
        <DialogContent className="flex max-h-[85vh] flex-col gap-4 overflow-hidden sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Database className="size-4" />
              Sources & RAG knowledge base
              <Badge variant="secondary">{allSources.length}</Badge>
            </DialogTitle>
            <DialogDescription>
              Files attached to this project as retrieval sources.
            </DialogDescription>
          </DialogHeader>

          <UploadDropzone onUploaded={handleUploaded} {...(createXhr ? { createXhr } : {})} />

          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <div className="relative min-w-[200px] flex-1">
              <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search sources…"
                className="h-8 pl-8 text-xs"
                aria-label="Search sources"
              />
            </div>

            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={() => setTypeFilter('all')}
                className={`rounded-md px-2 py-1 text-[11px] font-semibold ${typeFilter === 'all' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}
              >
                All
              </button>
              {availableTypes.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setTypeFilter(type)}
                  className={`rounded-md px-2 py-1 text-[11px] font-semibold ${typeFilter === type ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}
                >
                  {SOURCE_TYPE_LABELS[type]}
                </button>
              ))}
            </div>

            <Select value={sort} onValueChange={(value) => setSort(value as SortKey)}>
              <SelectTrigger className="h-8 w-44 shrink-0 text-xs" aria-label="Sort sources">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    Sort: {SORT_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex items-center gap-0.5 rounded-md border p-0.5">
              <Button
                type="button"
                variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                size="icon-xs"
                aria-label="Grid view"
                onClick={() => setViewMode('grid')}
              >
                <LayoutGrid />
              </Button>
              <Button
                type="button"
                variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                size="icon-xs"
                aria-label="List view"
                onClick={() => setViewMode('list')}
              >
                <List />
              </Button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">{sourcesBody}</div>
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
    </>
  );
}
