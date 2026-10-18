/** Whitespace-delimited word count — mirrors the server's `actualWords` derivation (`api/domain/outline.py`). */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/** Unicode code points in `text` (not UTF-16 units, so an emoji or math-alphabet letter counts once). */
export function characterCount(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    // A high surrogate followed by its low surrogate is one code point.
    if ((text.codePointAt(i) ?? 0) > 0xffff) i += 1;
    count += 1;
  }
  return count;
}
