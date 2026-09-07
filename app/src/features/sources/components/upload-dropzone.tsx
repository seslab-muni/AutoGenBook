import { useRef, useState, type DragEvent } from 'react';
import { AlertTriangle, Loader2, Upload, X } from 'lucide-react';

import type { FileDto } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useUploadQueue } from '@/features/sources/hooks/use-upload-queue';
import { formatBytes, KB_ELIGIBLE_EXTENSIONS } from '@/features/sources/lib/source-format';
import { cn } from '@/lib/utils';

const DISABLED_INGEST_TABS = ['arXiv import', 'BibTeX', 'Web URL'];
const ELIGIBLE_EXTENSIONS_LABEL = [...KB_ELIGIBLE_EXTENSIONS].map((ext) => `.${ext}`).join(' ');

interface UploadDropzoneProps {
  /** Called once per file that finished uploading *and* is KB-eligible. */
  onUploaded: (file: FileDto) => void;
  disabled?: boolean;
  /** Test seam, forwarded to `uploadFile` via `useUploadQueue`. */
  createXhr?: () => XMLHttpRequest;
}

/** Drag-drop/picker upload with per-file progress, cancel, and eligibility warnings. The other
 * ingest methods from the mock (arXiv, BibTeX, URL) are shown as disabled tabs, not built — the
 * backend has no endpoints for them yet (issue #5 explicitly defers them). */
export function UploadDropzone({ onUploaded, disabled, createXhr }: UploadDropzoneProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { items, enqueue, cancel, dismiss } = useUploadQueue({
    onUploaded: (file) => {
      if (file.kbEligible) onUploaded(file);
    },
    ...(createXhr ? { createXhr } : {}),
  });

  function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    enqueue([...fileList]);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    if (disabled) return;
    handleFiles(event.dataTransfer.files);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 text-xs">
        <span className="rounded-md bg-muted px-2.5 py-1 font-semibold text-foreground">
          File upload
        </span>
        {DISABLED_INGEST_TABS.map((label) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <span className="cursor-not-allowed rounded-md px-2.5 py-1 text-muted-foreground/60">
                {label}
              </span>
            </TooltipTrigger>
            <TooltipContent>Not available yet</TooltipContent>
          </Tooltip>
        ))}
      </div>

      <div
        role="button"
        tabIndex={0}
        aria-disabled={disabled}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(event) => {
          if (!disabled && (event.key === 'Enter' || event.key === ' ')) inputRef.current?.click();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={cn(
          'flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed p-6 text-center transition-colors',
          disabled
            ? 'cursor-not-allowed opacity-60'
            : 'cursor-pointer hover:border-primary/50 hover:bg-muted/30',
          dragOver && !disabled ? 'border-primary bg-muted/40' : 'border-border',
        )}
      >
        <Upload className="size-5 text-muted-foreground" />
        <p className="text-xs font-medium text-foreground">Drop files here or click to browse</p>
        <p className="text-[11px] text-muted-foreground">
          Eligible for RAG indexing: {ELIGIBLE_EXTENSIONS_LABEL}. Other files upload but can&apos;t
          be attached as sources.
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          disabled={disabled}
          className="sr-only"
          aria-label="Upload files"
          onChange={(event) => {
            handleFiles(event.target.files);
            event.target.value = '';
          }}
        />
      </div>

      {items.length > 0 ? (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-foreground" title={item.file.name}>
                    {item.file.name}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {formatBytes(item.file.size)}
                  </span>
                </div>
                {item.status === 'uploading' ? (
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-primary transition-[width]"
                      style={{ width: `${Math.round(item.progress * 100)}%` }}
                    />
                  </div>
                ) : item.status === 'error' ? (
                  <p className="mt-0.5 flex items-center gap-1 text-[11px] text-destructive">
                    <AlertTriangle className="size-3" />
                    {item.error}
                  </p>
                ) : item.status === 'done' && !item.eligible ? (
                  <p className="mt-0.5 flex items-center gap-1 text-[11px] text-warning">
                    <AlertTriangle className="size-3" />
                    Uploaded, but not eligible for RAG indexing — can&apos;t be attached as a
                    source.
                  </p>
                ) : item.status === 'done' ? (
                  <p className="mt-0.5 text-[11px] text-success">Attached.</p>
                ) : item.status === 'canceled' ? (
                  <p className="mt-0.5 text-[11px] text-muted-foreground">Canceled.</p>
                ) : null}
              </div>
              {item.status === 'uploading' ? (
                <>
                  <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Cancel ${item.file.name}`}
                    onClick={() => cancel(item.id)}
                  >
                    <X className="size-3.5" />
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Dismiss ${item.file.name}`}
                  onClick={() => dismiss(item.id)}
                >
                  <X className="size-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
