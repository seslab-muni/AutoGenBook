import { apiBaseUrl } from '@/api/client';

/** Absolute/data/protocol-relative URLs pass through; anything else is a run artifact file id. */
export function resolveImageSrc(src: string): string {
  if (/^(https?:)?\/\//.test(src) || src.startsWith('data:') || src.startsWith('blob:')) {
    return src;
  }
  return `${apiBaseUrl}/api/v1/files/${src}/content`;
}
