import { X } from 'lucide-react';

import type { FileDto } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { UploadDropzone } from '@/features/sources/components/upload-dropzone';
import {
  formatBytes,
  inferSourceType,
  SOURCE_TYPE_LABELS,
} from '@/features/sources/lib/source-format';
import type { PendingSource } from '@/features/sources/lib/pending-source';

interface SourcePickerProps {
  value: PendingSource[];
  onChange: (next: PendingSource[]) => void;
  /** Test seam, forwarded to `UploadDropzone`. */
  createXhr?: () => XMLHttpRequest;
}

/** Upload-and-attach step for the new-project wizard — no project exists yet, so uploaded files
 * are held here as `PendingSource`s and only become real `Source`s inside `ProjectCreate.sources`
 * once the project is created (issue #17's wizard deferred this; see `pending-source.ts`). */
export function SourcePicker({ value, onChange, createXhr }: SourcePickerProps) {
  function handleUploaded(file: FileDto) {
    onChange([
      ...value,
      {
        fileId: file.id,
        filename: file.filename,
        sizeBytes: file.sizeBytes,
        type: inferSourceType(file.filename),
        authors: '',
        year: '',
      },
    ]);
  }

  function updatePending(fileId: string, patch: Partial<PendingSource>) {
    onChange(value.map((source) => (source.fileId === fileId ? { ...source, ...patch } : source)));
  }

  function removePending(fileId: string) {
    onChange(value.filter((source) => source.fileId !== fileId));
  }

  return (
    <div className="space-y-2">
      <UploadDropzone onUploaded={handleUploaded} {...(createXhr ? { createXhr } : {})} />

      {value.length > 0 ? (
        <ul className="space-y-1.5">
          {value.map((source) => (
            <li
              key={source.fileId}
              className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span
                    className="truncate text-xs font-medium text-foreground"
                    title={source.filename}
                  >
                    {source.filename}
                  </span>
                  <Badge variant="secondary">{SOURCE_TYPE_LABELS[source.type]}</Badge>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {formatBytes(source.sizeBytes)}
                  </span>
                </div>
                <div className="mt-1 flex gap-1.5">
                  <Input
                    value={source.authors}
                    onChange={(event) =>
                      updatePending(source.fileId, { authors: event.target.value })
                    }
                    placeholder="Authors (optional)"
                    className="h-7 text-xs"
                    aria-label={`Authors for ${source.filename}`}
                  />
                  <Input
                    value={source.year}
                    onChange={(event) => updatePending(source.fileId, { year: event.target.value })}
                    placeholder="Year"
                    className="h-7 w-20 text-xs"
                    aria-label={`Year for ${source.filename}`}
                  />
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${source.filename}`}
                onClick={() => removePending(source.fileId)}
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
