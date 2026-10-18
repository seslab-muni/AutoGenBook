/**
 * Position map of one textblock: where each unit of the editor's inline content sits in the
 * Markdown source (issue #182, phase 5). The map is built either from the parse (`parse.ts`, remark
 * positions) or by the serializer (`serialize.ts`, which knows exactly where it wrote each piece),
 * and is consumed by `source-model.ts` for selection, highlights and anchor tracking.
 *
 * Offsets in a token are relative to the textblock's source origin (`TextblockInfo.s`), in UTF-16
 * units on both sides (the editor's text and the draft are both JS strings).
 */
export interface InlineToken {
  /** Editor offset of the token's first unit inside the textblock's content. */
  pm: number;
  /** Editor length: the text's length, or 1 for an atom / break. */
  len: number;
  /** Source start and end (end exclusive). */
  s: number;
  e: number;
  kind: 'text' | 'atom' | 'break';
  /** The marks the unit carries (a key; only compared for equality), for placing typed text. */
  marks: string;
  /**
   * Text whose characters are not a 1:1 copy of the source (escapes, entities, line prefixes):
   * source start and end of every character. Absent when `e - s === len` and the text is verbatim.
   */
  starts?: Int32Array;
  ends?: Int32Array;
}

export type InlineMap = readonly InlineToken[];

/** The largest index with `map[i].pm <= pm`, or -1. */
function lastStartingAtOrBefore(map: InlineMap, pm: number): number {
  let lo = 0;
  let hi = map.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid]!.pm <= pm) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The largest index with `map[i].s <= source`, or -1. */
function lastSourceStartingAtOrBefore(map: InlineMap, source: number): number {
  let lo = 0;
  let hi = map.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid]!.s <= source) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export type Edge = 'start' | 'end';

/**
 * Source offset (relative to the textblock's origin) of the editor offset `offset`. A range's start
 * uses `'start'` (it hugs the unit after the boundary), its end `'end'` (it hugs the unit before),
 * so a selection never takes in the delimiters around it.
 */
export function pmToSrc(map: InlineMap, offset: number, edge: Edge): number {
  if (map.length === 0) return 0;
  const i = lastStartingAtOrBefore(map, offset);
  if (i < 0) return map[0]!.s;
  const token = map[i]!;
  if (offset >= token.pm + token.len) {
    // At (or past) the end of the last token that starts before: the boundary with the next one.
    const next = map[i + 1];
    if (edge === 'start' && next) return next.s;
    return token.e;
  }
  if (offset === token.pm) {
    if (edge === 'end' && i > 0) return map[i - 1]!.e;
    return token.s;
  }
  const k = offset - token.pm;
  if (token.starts && token.ends) {
    return edge === 'start' ? token.starts[k]! : token.ends[k - 1]!;
  }
  if (token.kind !== 'text') return edge === 'start' ? token.s : token.e;
  return token.s + k;
}

/**
 * Editor offset of the source offset `source` (relative to the origin). An offset on delimiter
 * characters snaps forward for a range's start and backward for its end.
 */
export function srcToPm(map: InlineMap, source: number, edge: Edge): number {
  if (map.length === 0) return 0;
  const i = lastSourceStartingAtOrBefore(map, source);
  if (i < 0) return 0;
  const token = map[i]!;
  if (source >= token.e) {
    if (edge === 'end') return token.pm + token.len;
    const next = map[i + 1];
    return next ? next.pm : token.pm + token.len;
  }
  if (token.kind !== 'text') return edge === 'start' ? token.pm : token.pm + token.len;
  if (!token.starts || !token.ends) return token.pm + (source - token.s);
  // Largest character whose source starts at or before `source`.
  let lo = 0;
  let hi = token.len - 1;
  let k = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (token.starts[mid]! <= source) {
      k = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (source >= token.ends[k]!) return token.pm + k + 1;
  // Inside the character's own extent (an entity): the whole character is in or out.
  return edge === 'start' ? token.pm + k : token.pm + k + 1;
}

/** Whether the map has an atom or break token overlapping the source range `[s, e)`. */
export function atomsInSource(map: InlineMap, s: number, e: number): InlineToken[] {
  return map.filter((token) => token.kind !== 'text' && token.s < e && token.e > s);
}
