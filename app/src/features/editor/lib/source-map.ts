/**
 * Alignment of rendered text back to the Markdown it came from (issue #182). Remark keeps
 * `position.start.offset`/`end.offset` on every node, but a text node's *value* is not always its
 * source slice: escapes (`\*`), entities (`&lt;`), line prefixes in block quotes and list
 * indentation all make the value differ from the source. `alignValueToSource` recovers the
 * per-character map in those cases and gives up (null) otherwise, so callers fall back to
 * treating the node as one unit.
 */

const ENTITY = /^&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i;
const entityCache = new Map<string, string | null>();

/** The text an HTML character reference stands for, or null if it is not a known reference. */
export function decodeEntity(reference: string): string | null {
  const cached = entityCache.get(reference);
  if (cached !== undefined) return cached;
  let decoded: string | null = null;
  const body = reference.slice(1, -1);
  if (body.startsWith('#')) {
    const code =
      body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    decoded =
      Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : null;
  } else if (typeof document !== 'undefined') {
    const el = document.createElement('textarea');
    el.innerHTML = reference;
    decoded = el.value !== reference ? el.value : null;
  }
  entityCache.set(reference, decoded);
  return decoded;
}

/**
 * `map[i]` is the offset in `source` of `value[i]`, or `null` when the value cannot be aligned.
 * Characters the value gained (a trailing newline, a collapsed line break) map to the previous
 * character; entities map every character they decode to onto the `&`.
 */
export function alignValueToSource(value: string, source: string): Int32Array | null {
  const map = new Int32Array(value.length);
  if (value === source) {
    for (let i = 0; i < value.length; i += 1) map[i] = i;
    return map;
  }
  let p = 0;
  let i = 0;
  while (i < value.length) {
    const c = value.charCodeAt(i);
    const limit = Math.min(source.length, p + 64);
    let found = false;
    for (let q = p; q < limit; q += 1) {
      if (source.charCodeAt(q) === c) {
        map[i] = q;
        p = q + 1;
        i += 1;
        found = true;
        break;
      }
      if (source.charCodeAt(q) === 38 /* & */) {
        const match = ENTITY.exec(source.slice(q, q + 12));
        const decoded = match ? decodeEntity(match[0]) : null;
        if (match && decoded && value.startsWith(decoded, i)) {
          for (let k = 0; k < decoded.length; k += 1) map[i + k] = q;
          p = q + match[0].length;
          i += decoded.length;
          found = true;
          break;
        }
      }
    }
    if (found) continue;
    if (/\s/.test(value[i]!)) {
      // Whitespace the renderer added or collapsed: stay on the previous character.
      map[i] = Math.max(0, p - 1);
      i += 1;
      continue;
    }
    return null;
  }
  return map;
}
