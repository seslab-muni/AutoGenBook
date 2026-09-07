import type { SourceType } from '@/api/types';

/** Mirrors `rag_kb.py:SUPPORTED_EXTS` / `EXTENSION_KB_ELIGIBLE` in `src/mocks/handlers.ts` — the
 * only extensions the CLI's knowledge base actually indexes. Used to warn *before* upload; the
 * server's `kbEligible` on the returned `File` is still the source of truth. */
export const KB_ELIGIBLE_EXTENSIONS = new Set(['pdf', 'docx', 'pptx', 'md', 'txt']);

const EXTENSION_SOURCE_TYPE: Record<string, SourceType> = {
  pdf: 'pdf',
  docx: 'doc',
  pptx: 'ppt',
  md: 'md',
  txt: 'txt',
};

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  pdf: 'PDF',
  doc: 'Doc',
  ppt: 'Slides',
  md: 'Markdown',
  txt: 'Text',
  slides: 'Slides',
  arxiv: 'arXiv',
  notes: 'Notes',
  bibtex: 'BibTeX',
  latex: 'LaTeX',
  url: 'Web URL',
  book: 'Book',
  dataset: 'Dataset',
};

export function extensionOf(filename: string): string {
  return filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
}

export function isKbEligibleFilename(filename: string): boolean {
  return KB_ELIGIBLE_EXTENSIONS.has(extensionOf(filename));
}

export function inferSourceType(filename: string): SourceType {
  return EXTENSION_SOURCE_TYPE[extensionOf(filename)] ?? 'notes';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Display-only convenience key, not the CLI's real per-chunk `cite_key` (assigned at run time
 * from retrieval `rid`s — see `autogenbook/citations/ledger.py`). Lets users paste a placeholder
 * into `additionalRequirements`/notes before a run has produced real citations. */
export function suggestCiteKey(sourceName: string): string {
  const withoutExtension = sourceName.replace(/\.[^./]+$/, '');
  return (
    withoutExtension
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase() || 'source'
  );
}
