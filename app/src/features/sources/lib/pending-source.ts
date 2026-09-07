import type { SourceCreate, SourceType } from '@/api/types';

/** A source attached to the new-project wizard before the project exists — the file is already
 * uploaded (`POST /files`), but attaching it as a `Source` only happens when `POST /projects`
 * sends this list as `ProjectCreate.sources`. */
export interface PendingSource {
  fileId: string;
  filename: string;
  sizeBytes: number;
  type: SourceType;
  authors: string;
  year: string;
}

export function toSourceCreate(pending: PendingSource[]): SourceCreate[] {
  return pending.map((source) => ({
    fileId: source.fileId,
    type: source.type,
    ...(source.authors.trim() ? { authors: source.authors.trim() } : {}),
    ...(source.year.trim() ? { year: source.year.trim() } : {}),
  }));
}
