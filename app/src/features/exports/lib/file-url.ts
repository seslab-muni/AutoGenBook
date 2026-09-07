import { apiBaseUrl } from '@/api/client';

/**
 * Absolute URL for `GET /api/v1/files/{fileId}/content` — a plain `<a href>` to this downloads
 * the file through nginx (MinIO is internal-only), with no JS blob handling needed; the response
 * carries `Content-Disposition: attachment` so the browser saves it under the file's own name.
 * Same construction as `MarkdownView`'s `resolveImageSrc` — kept absolute (not a bare `/api/...`
 * path) so it still resolves correctly if `VITE_API_BASE_URL` ever points at a different origin.
 */
export function fileContentUrl(fileId: string): string {
  return `${apiBaseUrl}/api/v1/files/${fileId}/content`;
}
