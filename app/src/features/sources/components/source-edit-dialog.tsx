import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { useUpdateSourceMutation } from '@/api/queries/sources';
import type { Source } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SOURCE_TYPE_LABELS } from '@/features/sources/lib/source-format';

interface SourceEditDialogProps {
  projectId: string;
  source: Source | null;
  onOpenChange: (open: boolean) => void;
}

interface FormValues {
  authors: string;
  year: string;
  doi: string;
  url: string;
  description: string;
}

const EMPTY_VALUES: FormValues = { authors: '', year: '', doi: '', url: '', description: '' };

function toFormValues(source: Source): FormValues {
  return {
    authors: source.authors ?? '',
    year: source.year ?? '',
    doi: source.doi ?? '',
    url: source.url ?? '',
    description: source.description ?? '',
  };
}

/** Bibliographic metadata only — `SourceUpdate` (`api/schema.gen.ts`) has no `type` field; a
 * source's type is fixed at attach time from the file's extension. */
export function SourceEditDialog({ projectId, source, onOpenChange }: SourceEditDialogProps) {
  const [values, setValues] = useState<FormValues>(() =>
    source ? toFormValues(source) : EMPTY_VALUES,
  );
  const [lastSourceId, setLastSourceId] = useState<string | null>(null);
  const updateMutation = useUpdateSourceMutation(projectId, source?.id ?? '');

  if (source && source.id !== lastSourceId) {
    setLastSourceId(source.id);
    setValues(toFormValues(source));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!source) return;
    updateMutation.mutate(
      {
        authors: values.authors.trim(),
        year: values.year.trim(),
        doi: values.doi.trim(),
        url: values.url.trim(),
        description: values.description.trim(),
      },
      {
        onSuccess: () => {
          toast.success('Source metadata saved');
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={source !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit source metadata</DialogTitle>
          <DialogDescription className="flex items-center gap-2 truncate">
            <span className="truncate">{source?.name}</span>
            {source ? <Badge variant="secondary">{SOURCE_TYPE_LABELS[source.type]}</Badge> : null}
          </DialogDescription>
        </DialogHeader>
        <form id="source-edit-form" className="space-y-3" onSubmit={handleSubmit}>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label
                htmlFor="source-edit-authors"
                className="text-xs font-semibold text-foreground"
              >
                Authors
              </label>
              <Input
                id="source-edit-authors"
                value={values.authors}
                onChange={(event) => setValues((v) => ({ ...v, authors: event.target.value }))}
                placeholder="e.g. Ada Lovelace, Alan Turing"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="source-edit-year" className="text-xs font-semibold text-foreground">
                Year
              </label>
              <Input
                id="source-edit-year"
                value={values.year}
                onChange={(event) => setValues((v) => ({ ...v, year: event.target.value }))}
                placeholder="2026"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label htmlFor="source-edit-doi" className="text-xs font-semibold text-foreground">
                DOI
              </label>
              <Input
                id="source-edit-doi"
                value={values.doi}
                onChange={(event) => setValues((v) => ({ ...v, doi: event.target.value }))}
                placeholder="10.1145/357172.357176"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="source-edit-url" className="text-xs font-semibold text-foreground">
                URL
              </label>
              <Input
                id="source-edit-url"
                value={values.url}
                onChange={(event) => setValues((v) => ({ ...v, url: event.target.value }))}
                placeholder="https://…"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="source-edit-description"
              className="text-xs font-semibold text-foreground"
            >
              Description
            </label>
            <Textarea
              id="source-edit-description"
              rows={2}
              value={values.description}
              onChange={(event) => setValues((v) => ({ ...v, description: event.target.value }))}
            />
          </div>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="source-edit-form" disabled={updateMutation.isPending}>
            {updateMutation.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
