import { useCallback, useRef, useState } from 'react';

import { ApiError } from '@/api/client';
import type { FileDto } from '@/api/types';
import { uploadFile } from '@/api/upload';
import { isKbEligibleFilename } from '@/features/sources/lib/source-format';

export interface UploadQueueItem {
  id: string;
  file: File;
  /** Predicted client-side from the extension list; the server's `kbEligible` is authoritative. */
  eligible: boolean;
  progress: number;
  status: 'uploading' | 'done' | 'error' | 'canceled';
  error?: string;
  result?: FileDto;
}

interface UseUploadQueueOptions {
  /** Called once per successful upload, after the item lands in `items` as `done`. */
  onUploaded?: (file: FileDto) => void;
  /** Test seam, forwarded to `uploadFile` — see `api/upload.ts`. */
  createXhr?: () => XMLHttpRequest;
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 413) return 'File exceeds the server upload size limit.';
    return error.problem?.title ?? `Upload failed (${error.status || 'network error'}).`;
  }
  return 'Upload failed.';
}

/** Drives one `uploadFile` per queued file with independent progress/cancel, for `UploadDropzone`. */
export function useUploadQueue({ onUploaded, createXhr }: UseUploadQueueOptions = {}) {
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());

  const patch = useCallback((id: string, changes: Partial<UploadQueueItem>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...changes } : item)));
  }, []);

  const enqueue = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const id = crypto.randomUUID();
        const controller = new AbortController();
        controllers.current.set(id, controller);
        setItems((current) => [
          ...current,
          {
            id,
            file,
            eligible: isKbEligibleFilename(file.name),
            progress: 0,
            status: 'uploading',
          },
        ]);

        uploadFile(file, {
          signal: controller.signal,
          onProgress: (fraction) => patch(id, { progress: fraction }),
          ...(createXhr ? { createXhr } : {}),
        })
          .then((result) => {
            patch(id, { status: 'done', progress: 1, result, eligible: result.kbEligible });
            onUploaded?.(result);
          })
          .catch((error: unknown) => {
            if (error instanceof DOMException && error.name === 'AbortError') {
              patch(id, { status: 'canceled' });
              return;
            }
            patch(id, { status: 'error', error: describeError(error) });
          })
          .finally(() => controllers.current.delete(id));
      }
    },
    [createXhr, onUploaded, patch],
  );

  const cancel = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
  }, []);

  const dismiss = useCallback((id: string) => {
    controllers.current.delete(id);
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  return { items, enqueue, cancel, dismiss };
}
