/**
 * Text-quote anchors over a section's Markdown source (issue #182, phase 2). Pure TypeScript, no
 * React. An anchor is a W3C text-quote selector,
 * `{ quote, prefix, suffix, start, end }`, whose `start`/`end` count Unicode code points (the
 * unit the API stores; JS strings are UTF-16, so every public function here that takes or returns
 * an `Anchor` converts), `end` exclusive; both `null` means orphaned.
 *
 * `resolveAnchor` follows the engine's reference (`engine/util/anchors.py`) with the stricter
 * rules agreed in review (a false positive is worse than an orphan):
 *
 *  1. the stored offsets win only when they still hold the quote and the quote is unique, else
 *  2. an exact match, disambiguated by prefix/suffix agreement and then by distance to the stored
 *     start; a tie that cannot be broken (identical context, no clear nearest hit) orphans,
 *  3. a whitespace-normalised match, same disambiguation,
 *  4. a bounded fuzzy match near seed hits / the stored offset, only for quotes of at least
 *     {@link MIN_FUZZY_CHARS} characters and {@link MIN_FUZZY_WORDS} words; the span is capped at
 *     1.1x the quote, snapped to word boundaries and re-scored as a whole against the threshold.
 *     Quotes longer than {@link HEAD_TAIL_THRESHOLD} match by their first and last
 *     {@link HEAD_TAIL_LEN} characters instead,
 *  5. otherwise orphaned.
 *
 * Whenever a match is found `text.slice(start, end) === quote` holds (in code points): the quote is
 * rewritten to the matched text and the context refreshed.
 */

export const CONTEXT = 32;
export const FUZZY_THRESHOLD = 0.8;
export const MIN_FUZZY_CHARS = 12;
export const MIN_FUZZY_WORDS = 3;
export const MAX_FUZZY_LEN = 2000;
export const HEAD_TAIL_THRESHOLD = 2000;
export const HEAD_TAIL_LEN = 200;
const MAX_POSITIONS = 5000;
const NEAR_WINDOW = 2000;
/** Cells (pattern length x region length) one fuzzy alignment may spend. */
const MAX_DP_CELLS = 8_000_000;

export interface Anchor {
  quote: string;
  prefix: string;
  suffix: string;
  start: number | null;
  end: number | null;
}

/** What the API hands over: every field may be missing. */
export type AnchorInput = Partial<Anchor>;

/** A half-open range in some unit (UTF-16 units or code points, the caller knows). */
export interface TextRange {
  start: number;
  end: number;
}

/** `[from, to)` replaced by `insertedLength` units. */
export interface TextChange {
  from: number;
  to: number;
  insertedLength: number;
}

// ------------------------------------------------------------- code point <-> UTF-16

/** Converts between code-point offsets and UTF-16 offsets of one text. */
export class CodePointIndex {
  /** UTF-16 index of every surrogate pair's high half, ascending. */
  private readonly pairs: number[] = [];
  readonly units: number;

  constructor(text: string) {
    this.units = text.length;
    for (let i = 0; i < text.length - 1; i += 1) {
      const unit = text.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          this.pairs.push(i);
          i += 1;
        }
      }
    }
  }

  /** Code points in the text. */
  get length(): number {
    return this.units - this.pairs.length;
  }

  /** Code-point offset -> UTF-16 offset. */
  toUnit(cp: number): number {
    // Pair j sits at code point `pairs[j] - j`; count the pairs strictly before `cp`.
    let lo = 0;
    let hi = this.pairs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.pairs[mid]! - mid < cp) lo = mid + 1;
      else hi = mid;
    }
    return cp + lo;
  }

  /** UTF-16 offset -> code-point offset (an offset inside a pair counts the whole pair). */
  toCp(unit: number): number {
    let lo = 0;
    let hi = this.pairs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.pairs[mid]! < unit) lo = mid + 1;
      else hi = mid;
    }
    return unit - lo;
  }
}

/** Code points in `text` (what the API's `len(quote)` counts). */
export function codePointLength(text: string): number {
  return new CodePointIndex(text).length;
}

// --------------------------------------------------------------------- make / orphan

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function anchorFromUnits(text: string, index: CodePointIndex, start: number, end: number): Anchor {
  return {
    quote: text.slice(start, end),
    prefix: sliceCodePointsBefore(text, start),
    suffix: sliceCodePointsAfter(text, end),
    start: index.toCp(start),
    end: index.toCp(end),
  };
}

/** Up to `CONTEXT` code points ending at UTF-16 offset `unit`. */
function sliceCodePointsBefore(text: string, unit: number): string {
  let from = Math.max(0, unit - CONTEXT);
  if (from > 0 && isLow(text.charCodeAt(from)) && isHigh(text.charCodeAt(from - 1))) from -= 1;
  // `CONTEXT` units can hold fewer than CONTEXT code points; the API allows "up to".
  return text.slice(from, unit);
}

function sliceCodePointsAfter(text: string, unit: number): string {
  let to = Math.min(text.length, unit + CONTEXT);
  if (to < text.length && isLow(text.charCodeAt(to)) && isHigh(text.charCodeAt(to - 1))) to += 1;
  return text.slice(unit, to);
}

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The anchor for `text[from:to]`, both in code points. Throws `RangeError` outside the text. */
export function makeAnchor(text: string, from: number, to: number): Anchor {
  const index = new CodePointIndex(text);
  if (!isInt(from) || !isInt(to) || from < 0 || from > to || to > index.length) {
    throw new RangeError(`range ${from}:${to} is outside the text (length ${index.length})`);
  }
  return anchorFromUnits(text, index, index.toUnit(from), index.toUnit(to));
}

function orphan(anchor: AnchorInput): Anchor {
  return {
    quote: anchor.quote ?? '',
    prefix: anchor.prefix ?? '',
    suffix: anchor.suffix ?? '',
    start: null,
    end: null,
  };
}

export function isOrphaned(anchor: AnchorInput): boolean {
  return !isInt(anchor.start) || !isInt(anchor.end);
}

// ------------------------------------------------------------------- text views

/** A copy of the text plus, per view character, the original UTF-16 index it came from. */
interface View {
  s: string;
  idx: Uint32Array | null;
}

const IDENTITY = (text: string): View => ({ s: text, idx: null });

function collapseWhitespace(text: string): View {
  const out: string[] = [];
  const idx: number[] = [];
  let inSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (!inSpace) {
        out.push(' ');
        idx.push(i);
        inSpace = true;
      }
      continue;
    }
    inSpace = false;
    out.push(ch);
    idx.push(i);
  }
  return { s: out.join(''), idx: Uint32Array.from(idx) };
}

function collapseString(value: string): string {
  return value.replace(/\s+/g, ' ');
}

function viewToUnit(view: View, hint: number | null): number | null {
  if (hint === null) return null;
  if (!view.idx) return hint;
  // First view index whose original index is >= hint.
  let lo = 0;
  let hi = view.idx.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (view.idx[mid]! < hint) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function viewToOrig(view: View, start: number, end: number): TextRange {
  if (!view.idx) return { start, end };
  return { start: view.idx[start]!, end: view.idx[end - 1]! + 1 };
}

// ------------------------------------------------------------ exact match ladder

function findAll(haystack: string, needle: string, limit = MAX_POSITIONS): number[] | 'many' {
  if (!needle) return [];
  const out: number[] = [];
  let pos = haystack.indexOf(needle);
  while (pos !== -1) {
    if (out.length >= limit) return 'many';
    out.push(pos);
    pos = haystack.indexOf(needle, pos + 1);
  }
  return out;
}

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1;
  return n;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

function contextScore(hay: string, i: number, j: number, prefix: string, suffix: string): number {
  let score = 0;
  if (prefix) score += commonSuffix(hay.slice(Math.max(0, i - prefix.length), i), prefix);
  if (suffix) score += commonPrefix(hay.slice(j, j + suffix.length), suffix);
  return score;
}

/**
 * Among several exact hits: most prefix/suffix agreement, then nearest to the stored start. Returns
 * null when the best hit is not clearly better than the runner-up (identical context and no
 * unambiguous nearest hit): the caller then orphans rather than guess.
 */
function pickPosition(
  hay: string,
  positions: number[] | 'many',
  needle: string,
  prefix: string,
  suffix: string,
  hint: number | null,
): number | null {
  let candidates: number[];
  if (positions === 'many') {
    // Far too many hits to rank: only trust the neighbourhood of the stored offset.
    if (hint === null) return null;
    candidates = [];
    let pos = hay.indexOf(needle, Math.max(0, hint - NEAR_WINDOW));
    while (pos !== -1 && pos <= hint + NEAR_WINDOW && candidates.length < 400) {
      candidates.push(pos);
      pos = hay.indexOf(needle, pos + 1);
    }
    if (candidates.length === 0) return null;
  } else {
    candidates = positions;
  }
  if (candidates.length === 1 && positions !== 'many') return candidates[0]!;

  const length = needle.length;
  const scored = candidates.map((i) => ({
    i,
    ctx: contextScore(hay, i, i + length, prefix, suffix),
    dist: hint === null ? 0 : Math.abs(i - hint),
  }));
  const best = Math.max(...scored.map((c) => c.ctx));
  const top = scored.filter((c) => c.ctx === best);
  if (top.length === 1) return top[0]!.i;
  if (hint === null) return null;
  top.sort((a, b) => a.dist - b.dist);
  // Identical context everywhere: keep the hit at (or clearly nearest to) the stored offset.
  if (top[0]!.dist < top[1]!.dist && top[0]!.dist <= NEAR_WINDOW) return top[0]!.i;
  return null;
}

/** Exact hit of `quote` in `view`, disambiguated. `'none'` = no hit, `null` = ambiguous. */
function locateExact(
  view: View,
  quote: string,
  prefix: string,
  suffix: string,
  hint: number | null,
): TextRange | 'none' | null {
  const positions = findAll(view.s, quote);
  if (positions !== 'many' && positions.length === 0) return 'none';
  const hintV = viewToUnit(view, hint);
  const at = pickPosition(view.s, positions, quote, prefix, suffix, hintV);
  return at === null ? null : viewToOrig(view, at, at + quote.length);
}

// -------------------------------------------------------------- approximate match

function wordCount(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

interface Alignment {
  start: number;
  end: number;
  dist: number;
}

/**
 * Sellers' approximate substring matching with the start tracked: every end `j` of
 * `text[lo:hi]` with its best edit distance `<= maxDist` and where that alignment starts.
 */
function alignQuote(
  pattern: string,
  text: string,
  lo: number,
  hi: number,
  maxDist: number,
): Alignment[] {
  const m = hi - lo;
  const n = pattern.length;
  if (m <= 0 || n * m > MAX_DP_CELLS) return [];
  let prevD = new Uint16Array(m + 1);
  let prevS = new Uint32Array(m + 1);
  let curD = new Uint16Array(m + 1);
  let curS = new Uint32Array(m + 1);
  for (let j = 0; j <= m; j += 1) prevS[j] = j;
  for (let i = 1; i <= n; i += 1) {
    curD[0] = i;
    curS[0] = 0;
    const pc = pattern.charCodeAt(i - 1);
    for (let j = 1; j <= m; j += 1) {
      const cost = pc === text.charCodeAt(lo + j - 1) ? 0 : 1;
      let d = prevD[j - 1]! + cost;
      let s = prevS[j - 1]!;
      const up = prevD[j]! + 1;
      if (up < d) {
        d = up;
        s = prevS[j]!;
      }
      const left = curD[j - 1]! + 1;
      if (left < d) {
        d = left;
        s = curS[j - 1]!;
      }
      curD[j] = d;
      curS[j] = s;
    }
    [prevD, curD] = [curD, prevD];
    [prevS, curS] = [curS, prevS];
  }
  const out: Alignment[] = [];
  for (let j = 1; j <= m; j += 1) {
    if (prevD[j]! <= maxDist) out.push({ start: lo + prevS[j]!, end: lo + j, dist: prevD[j]! });
  }
  return out;
}

/** Levenshtein distance, two rows. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(
        prev[j - 1]! + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1),
        prev[j]! + 1,
        cur[j - 1]! + 1,
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - editDistance(a, b) / longest;
}

const WORD = /[\p{L}\p{N}_]/u;

/** Moves a span's edges off the middle of a word (shrinking it, by a few characters at most). */
function snapToWords(text: string, start: number, end: number): TextRange {
  let s = start;
  let e = end;
  let guard = 0;
  while (s < e && guard < 6 && s > 0 && WORD.test(text[s - 1]!) && WORD.test(text[s]!)) {
    s += 1;
    guard += 1;
  }
  guard = 0;
  while (e > s && guard < 6 && e < text.length && WORD.test(text[e - 1]!) && WORD.test(text[e]!)) {
    e -= 1;
    guard += 1;
  }
  while (s < e && /\s/.test(text[s]!)) s += 1;
  while (e > s && /\s/.test(text[e - 1]!)) e -= 1;
  return { start: s, end: e };
}

function fixSurrogates(text: string, range: TextRange): TextRange {
  let { start, end } = range;
  if (start > 0 && isLow(text.charCodeAt(start)) && isHigh(text.charCodeAt(start - 1))) start += 1;
  if (end < text.length && isLow(text.charCodeAt(end)) && isHigh(text.charCodeAt(end - 1)))
    end -= 1;
  return { start, end };
}

function fuzzyRegions(text: string, quote: string, hint: number | null): [number, number][] {
  const n = quote.length;
  const slack = Math.max(8, Math.floor(n / 4));
  const regions: [number, number][] = [];
  const seedLen = n < 40 ? 8 : 12;
  const step = Math.max(1, Math.floor((n - seedLen) / 11));
  const aligned: number[] = [];
  for (let off = 0; off + seedLen <= n; off += step) {
    const seed = quote.slice(off, off + seedLen);
    if (new Set(seed).size < 3) continue;
    let pos = text.indexOf(seed);
    let hits = 0;
    while (pos !== -1 && hits < 25) {
      aligned.push(pos - off);
      hits += 1;
      pos = text.indexOf(seed, pos + 1);
    }
  }
  aligned.sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const a of aligned) {
    const last = clusters[clusters.length - 1];
    if (last && a - last[last.length - 1]! <= slack) last.push(a);
    else clusters.push([a]);
  }
  clusters.sort((a, b) => b.length - a.length);
  for (const cluster of clusters.slice(0, 6)) {
    regions.push([
      Math.max(0, cluster[0]! - slack),
      Math.min(text.length, cluster[cluster.length - 1]! + n + slack),
    ]);
  }
  if (hint !== null) {
    const w = Math.max(200, n);
    regions.push([Math.max(0, hint - w), Math.min(text.length, hint + n + w)]);
  }
  return regions;
}

interface Scored {
  range: TextRange;
  score: number;
  sim: number;
}

function fuzzyEdit(
  text: string,
  quote: string,
  prefix: string,
  suffix: string,
  hint: number | null,
): TextRange | null {
  const n = quote.length;
  const maxDist = Math.floor(n * (1 - FUZZY_THRESHOLD));
  const scored: Scored[] = [];
  const seen = new Set<string>();
  for (const [lo, hi] of fuzzyRegions(text, quote, hint)) {
    const ends = alignQuote(quote, text, lo, hi, maxDist);
    // Best few ends by distance, then closeness of the span length to the quote's.
    ends.sort(
      (a, b) => a.dist - b.dist || Math.abs(a.end - a.start - n) - Math.abs(b.end - b.start - n),
    );
    for (const candidate of ends.slice(0, 6)) {
      if (candidate.end - candidate.start > Math.ceil(n * 1.1)) continue;
      const snapped = fixSurrogates(text, snapToWords(text, candidate.start, candidate.end));
      if (snapped.end - snapped.start < Math.floor(n * 0.7)) continue;
      const key = `${snapped.start}:${snapped.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sim = similarity(quote, text.slice(snapped.start, snapped.end));
      if (sim < FUZZY_THRESHOLD) continue;
      const ctx =
        contextScore(text, snapped.start, snapped.end, prefix, suffix) /
        Math.max(1, prefix.length + suffix.length);
      const near = hint === null ? 0 : -Math.abs(snapped.start - hint) / (text.length + 1);
      scored.push({ range: snapped, sim, score: sim + 0.15 * ctx + 0.05 * near });
    }
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]!;
  const rival = scored.find(
    (other) =>
      other !== best &&
      (other.range.end <= best.range.start || other.range.start >= best.range.end) &&
      best.score - other.score < 0.02,
  );
  return rival ? null : best.range;
}

/** Quotes beyond the DP budget: both ends must be found, at a plausible distance. */
function fuzzyHeadTail(text: string, quote: string, hint: number | null): TextRange | null {
  const head = quote.slice(0, HEAD_TAIL_LEN);
  const tail = quote.slice(-HEAD_TAIL_LEN);
  const heads = findAll(text, head, 200);
  const tails = findAll(text, tail, 200);
  if (heads === 'many' || tails === 'many') return null;
  const n = quote.length;
  const pairs: TextRange[] = [];
  for (const h of heads) {
    for (const t of tails) {
      const end = t + tail.length;
      const len = end - h;
      if (len >= n * 0.9 && len <= n * 1.1) pairs.push({ start: h, end });
    }
  }
  if (pairs.length === 0) return null;
  pairs.sort(
    (a, b) =>
      (hint === null ? a.start : Math.abs(a.start - hint)) -
      (hint === null ? b.start : Math.abs(b.start - hint)),
  );
  if (pairs.length > 1 && hint === null) return null;
  return pairs[0]!;
}

function locateFuzzy(
  text: string,
  quote: string,
  prefix: string,
  suffix: string,
  hint: number | null,
): TextRange | null {
  const trimmed = quote.trim();
  if (trimmed.length < MIN_FUZZY_CHARS || wordCount(trimmed) < MIN_FUZZY_WORDS) return null;
  if (trimmed.length > HEAD_TAIL_THRESHOLD) return fuzzyHeadTail(text, trimmed, hint);
  if (trimmed.length > MAX_FUZZY_LEN) return null;
  return fuzzyEdit(text, trimmed, prefix, suffix, hint);
}

// --------------------------------------------------------------------- resolve

/**
 * `anchor` located in `text`: fresh `start`/`end` (and refreshed quote/prefix/suffix) when found,
 * `start`/`end` null when it is orphaned (not found, or ambiguous).
 */
export function resolveAnchor(text: string, anchor: AnchorInput): Anchor {
  const quote = anchor.quote ?? '';
  const prefix = anchor.prefix ?? '';
  const suffix = anchor.suffix ?? '';
  if (!quote) return orphan(anchor);
  const index = new CodePointIndex(text);
  const range = locateUnits(text, index, { quote, prefix, suffix, start: anchor.start ?? null });
  return range ? anchorFromUnits(text, index, range.start, range.end) : orphan(anchor);
}

/**
 * Same as {@link resolveAnchor} but answers in UTF-16 units (what CodeMirror and the DOM use),
 * `null` when orphaned.
 */
export function resolveAnchorUnits(text: string, anchor: AnchorInput): TextRange | null {
  const quote = anchor.quote ?? '';
  if (!quote) return null;
  const index = new CodePointIndex(text);
  return locateUnits(text, index, {
    quote,
    prefix: anchor.prefix ?? '',
    suffix: anchor.suffix ?? '',
    start: anchor.start ?? null,
  });
}

function locateUnits(
  text: string,
  index: CodePointIndex,
  anchor: { quote: string; prefix: string; suffix: string; start: number | null },
): TextRange | null {
  const { quote, prefix, suffix } = anchor;
  const hintCp =
    isInt(anchor.start) && anchor.start >= 0 && anchor.start <= index.length ? anchor.start : null;
  const hint = hintCp === null ? null : index.toUnit(hintCp);

  // 1. The stored offsets still hold the quote, and nothing else does.
  if (hint !== null && text.startsWith(quote, hint)) {
    const next = text.indexOf(quote, hint + 1);
    const prev = hint > 0 ? text.lastIndexOf(quote, hint - 1) : -1;
    if (next === -1 && prev === -1) return { start: hint, end: hint + quote.length };
  }

  // 2. Exact, then whitespace-normalised.
  const exact = locateExact(IDENTITY(text), quote, prefix, suffix, hint);
  if (exact === null) return null;
  if (exact !== 'none') return exact;

  const collapsedQuote = collapseString(quote).trim();
  if (collapsedQuote) {
    const view = collapseWhitespace(text);
    const folded = locateExact(
      view,
      collapsedQuote,
      collapseString(prefix),
      collapseString(suffix),
      hint,
    );
    if (folded === null) return null;
    if (folded !== 'none') return folded;
  }

  // 3. Fuzzy.
  return locateFuzzy(text, quote, prefix, suffix, hint);
}

// ------------------------------------------------------------------ edit mapping

/**
 * The range after `change`, or `null` when the change swallowed it. Text typed exactly at either
 * edge stays outside the range; a change overlapping one edge keeps the untouched remainder.
 */
export function mapRangeThroughChange(range: TextRange, change: TextChange): TextRange | null {
  const { start, end } = range;
  const { from, to, insertedLength } = change;
  const delta = insertedLength - (to - from);
  if (to <= start) return { start: start + delta, end: end + delta };
  if (from >= end) return { start, end };
  if (from <= start && to >= end) return null;
  if (from > start && to < end) return { start, end: end + delta };
  if (from <= start) {
    // Overlaps the head: the remainder is [to, end), pushed behind the inserted text.
    return { start: from + insertedLength, end: end + delta };
  }
  // Overlaps the tail: the remainder is [start, from).
  return { start, end: from };
}

/**
 * The single contiguous change that turns `before` into `after` (common prefix/suffix trimmed),
 * in UTF-16 units, or `null` when they are equal. Never splits a surrogate pair.
 */
export function diffChange(before: string, after: string): TextChange | null {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p += 1;
  if (p > 0 && isHigh(before.charCodeAt(p - 1))) p -= 1;
  let s = 0;
  while (
    s < max - p &&
    before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)
  ) {
    s += 1;
  }
  if (s > 0 && isLow(before.charCodeAt(before.length - s))) s -= 1;
  return { from: p, to: before.length - s, insertedLength: after.length - s - p };
}

/**
 * An anchor after `change` (code points) was applied, producing `newText`: offsets shifted, quote
 * and context re-read from the new text. Orphaned when the change swallowed the range.
 */
export function mapAnchorThroughChange(
  anchor: Anchor,
  change: TextChange,
  newText: string,
): Anchor {
  if (!isInt(anchor.start) || !isInt(anchor.end)) return anchor;
  const mapped = mapRangeThroughChange({ start: anchor.start, end: anchor.end }, change);
  if (!mapped) return orphan(anchor);
  const index = new CodePointIndex(newText);
  if (mapped.end > index.length) return orphan(anchor);
  return anchorFromUnits(newText, index, index.toUnit(mapped.start), index.toUnit(mapped.end));
}
