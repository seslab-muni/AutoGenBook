/** Whitespace-delimited word count — mirrors the server's `actualWords` derivation (`api/domain/outline.py`). */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}
