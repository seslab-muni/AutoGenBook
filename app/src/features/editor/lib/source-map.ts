/**
 * Alignment of rendered text back to the Markdown it came from (issue #182). Remark keeps
 * `position.start.offset`/`end.offset` on every node, but a text node's *value* is not always its
 * source slice: escapes (`\*`), entities (`&amp;`), line prefixes in block quotes and list
 * indentation all make the value shorter than the source. `alignValueToSource` recovers the
 * per-character map in the common cases and gives up (null) otherwise, so callers fall back to
 * treating the node as one unit.
 */

/** `map[i]` is the offset in `source` of `value[i]`, or `null` when the value cannot be aligned. */
export function alignValueToSource(value: string, source: string): Int32Array | null {
  const map = new Int32Array(value.length);
  if (value === source) {
    for (let i = 0; i < value.length; i += 1) map[i] = i;
    return map;
  }
  let p = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    // Skip source characters the value dropped (backslashes, `> ` prefixes, entity bodies...),
    // but never run far: a long gap means this is not the same text.
    const limit = Math.min(source.length, p + 64);
    while (p < limit && source.charCodeAt(p) !== c) p += 1;
    if (p >= limit || source.charCodeAt(p) !== c) return null;
    map[i] = p;
    p += 1;
  }
  return map;
}
