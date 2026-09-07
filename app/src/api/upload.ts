import { apiBaseUrl, ApiError } from './client';
import { getAuthHeaders } from '@/auth/session';
import type { FileDto, Problem } from './types';

export interface UploadOptions {
  onProgress?: (fractionComplete: number) => void;
  signal?: AbortSignal;
  /**
   * Test seam: construct the transport. Defaults to `new XMLHttpRequest()`.
   * Real browsers' `XMLHttpRequest` + jsdom's `File`/`FormData` don't survive
   * MSW's Node-side multipart interception intact, so `upload.test.ts` drives
   * a fake here instead of routing a real request through MSW.
   */
  createXhr?: () => XMLHttpRequest;
}

/**
 * Uploads a file to `POST /api/v1/files` via `XMLHttpRequest` — `fetch` has
 * no upload-progress event, which `onProgress` needs.
 */
export function uploadFile(file: File, options: UploadOptions = {}): Promise<FileDto> {
  const { onProgress, signal, createXhr = () => new XMLHttpRequest() } = options;

  return new Promise((resolve, reject) => {
    const xhr = createXhr();
    xhr.open('POST', `${apiBaseUrl}/api/v1/files`);

    for (const [name, value] of Object.entries(getAuthHeaders())) {
      xhr.setRequestHeader(name, value);
    }

    if (onProgress) {
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) {
          onProgress(event.loaded / event.total);
        }
      });
    }

    const onAbort = (): void => {
      xhr.abort();
    };
    signal?.addEventListener('abort', onAbort);

    xhr.addEventListener('loadend', () => {
      signal?.removeEventListener('abort', onAbort);
    });

    xhr.addEventListener('abort', () => {
      reject(new DOMException('Upload aborted', 'AbortError'));
    });

    xhr.addEventListener('error', () => {
      reject(new ApiError({ status: 0, problem: undefined, url: xhr.responseURL }));
    });

    xhr.addEventListener('load', () => {
      const problem = parseProblem(xhr);
      if (xhr.status === 413) {
        reject(
          new ApiError({
            status: 413,
            problem: problem ?? {
              type: 'about:blank',
              title: 'Payload Too Large',
              status: 413,
              instance: xhr.responseURL,
            },
            url: xhr.responseURL,
          }),
        );
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new ApiError({ status: xhr.status, problem, url: xhr.responseURL }));
        return;
      }
      try {
        resolve(JSON.parse(xhr.responseText) as FileDto);
      } catch (cause) {
        reject(
          new ApiError({ status: xhr.status, problem: undefined, url: xhr.responseURL, cause }),
        );
      }
    });

    const formData = new FormData();
    formData.set('file', file);
    xhr.send(formData);
  });
}

function parseProblem(xhr: XMLHttpRequest): Problem | undefined {
  try {
    const parsed: unknown = JSON.parse(xhr.responseText);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'status' in parsed &&
      'title' in parsed &&
      'type' in parsed &&
      'instance' in parsed
    ) {
      return parsed as Problem;
    }
  } catch {
    // response body wasn't a Problem — fall through
  }
  return undefined;
}
