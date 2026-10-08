import type { Mark, Node as PMNode } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import type { Step } from 'prosemirror-transform';

import type { InlineToken } from './inline-map';
import { marksKey, type Segment, type TextblockInfo } from './parse';
import type { TextChange } from '@/features/editor/lib/anchors';

import { escapeText, reads, type EscapeLevel } from './serialize';

/**
 * Typing, deleting and replacing text inside one run of text change the *source* by exactly that
 * text (issue #182, phase 5): no block is written again, so nothing else in the block can change
 * (an `_` emphasis stays `_`, an entity stays an entity, escapes stay), the source change is the
 * minimal one anchors are mapped through, and typing costs one splice and one verification parse.
 *
 * Anything this cannot do exactly (the edit spans delimiters or several runs, the marks of the typed
 * text do not match the run it lands in, the run's characters are not a plain copy of the source)
 * answers `null` and the caller writes the block with the serializer instead.
 */

/** A transaction that is one text replacement inside one block: what `patchSegment` can apply. */
export interface TextEdit {
  /** Editor positions in the document before the edit. */
  from: number;
  to: number;
  text: string;
  marks: readonly Mark[];
}

/** The edit a transaction's steps made, if they are one plain text replacement (one step, text only). */
export function textEditOf(steps: readonly Step[]): TextEdit | null {
  const step = steps.length === 1 ? steps[0] : null;
  if (!(step instanceof ReplaceStep)) return null;
  const { slice } = step;
  if (slice.openStart !== 0 || slice.openEnd !== 0) return null;
  let text = '';
  let marks: readonly Mark[] | null = null;
  let plain = true;
  slice.content.forEach((child) => {
    if (!child.isText) {
      plain = false;
      return;
    }
    text += child.text!;
    if (marks === null) marks = child.marks;
    else if (marksKey(marks) !== marksKey(child.marks)) plain = false;
  });
  if (!plain || text.includes('\n')) return null;
  return { from: step.from, to: step.to, text, marks: marks ?? [] };
}

const charStart = (token: InlineToken, i: number) => token.starts?.[i] ?? token.s + i;
const charEnd = (token: InlineToken, i: number) => token.ends?.[i] ?? token.s + i + 1;

interface Host {
  index: number;
  /** Characters of the token before the edit, and up to where the edit reaches. */
  k: number;
  kEnd: number;
}

/** The text token an edit at inline offsets `[p, q)` belongs to, and where in it. */
function hostToken(
  tb: TextblockInfo,
  p: number,
  q: number,
  key: string,
  inserting: boolean,
): Host | null {
  const map = tb.map;
  if (q > p) {
    // A deletion or replacement: both ends inside one text token.
    const index = map.findIndex((t) => t.kind === 'text' && t.pm <= p && q <= t.pm + t.len);
    if (index < 0) return null;
    const token = map[index]!;
    if (inserting && token.marks !== key) return null;
    return { index, k: p - token.pm, kEnd: q - token.pm };
  }
  // A pure insertion: inside a token, or at the edge between two (the one with the typed marks).
  const inside = map.findIndex((t) => t.kind === 'text' && t.pm < p && p < t.pm + t.len);
  if (inside >= 0) {
    const token = map[inside]!;
    return token.marks === key ? { index: inside, k: p - token.pm, kEnd: p - token.pm } : null;
  }
  const left = map.findIndex((t) => t.pm + t.len === p);
  const right = map.findIndex((t) => t.pm === p);
  const L = left >= 0 ? map[left]! : null;
  const R = right >= 0 ? map[right]! : null;
  if (L && L.kind === 'text' && L.marks === key) return { index: left, k: L.len, kEnd: L.len };
  if (R && R.kind === 'text' && R.marks === key) return { index: right, k: 0, kEnd: 0 };
  return null;
}

/** Everything in the token before character `k` is not in the source (or nothing is before it). */
function allZeroBefore(token: InlineToken, k: number): boolean {
  if (!token.starts || !token.ends) return k === 0;
  for (let i = 0; i < k; i += 1) if (token.starts[i] !== token.ends[i]) return false;
  return true;
}

const isZeroWidth = (token: InlineToken, i: number) => token.starts![i] === token.ends![i];

function zeroWidthStays(
  token: InlineToken,
  k: number,
  kEnd: number,
  first: boolean,
  last: boolean,
): boolean {
  let leadEnd = 0;
  while (leadEnd < token.len && isZeroWidth(token, leadEnd)) leadEnd += 1;
  let trailStart = token.len;
  while (trailStart > leadEnd && isZeroWidth(token, trailStart - 1)) trailStart -= 1;
  for (let i = 0; i < token.len; i += 1) {
    if (!isZeroWidth(token, i)) continue;
    if (i >= k && i < kEnd) continue;
    if (first && i < leadEnd && i < k) continue;
    if (last && i >= trailStart && i >= kEnd) continue;
    return false;
  }
  return true;
}

function shiftToken(token: InlineToken, pmDelta: number, srcDelta: number): InlineToken {
  const next: InlineToken = {
    ...token,
    pm: token.pm + pmDelta,
    s: token.s + srcDelta,
    e: token.e + srcDelta,
  };
  if (token.starts && token.ends) {
    next.starts = token.starts.map((v) => v + srcDelta);
    next.ends = token.ends.map((v) => v + srcDelta);
  }
  return next;
}

const INERT_TEXT = /^[\p{L}\p{N} .,;!?'"()%-]+$/u;
const SAFE_NEIGHBOUR = /[\p{L}\p{N} .,;!?'"()%-]/u;
const WORD_SPECIALS = /[&@:\\<>`*_[\]~|]|www\./i;
/** What a line may hold before the text if the text could still be the start of a list, a heading, a rule... */
const STRUCTURAL_PREFIX = /^[ \t>\-+*#\d.)=_~`]*$/;
const INERT_MAX = 64;

/**
 * Whether the edit is plain prose: letters, digits and spaces typed or deleted inside a word or
 * between words, far from the start of a line, with nothing in the neighbouring word that is
 * Markdown syntax. Such an edit cannot change what any other part of the document means, so it
 * needs no parse at all (it is what a person types almost all the time - and what a block of
 * hundreds of kilobytes must not pay a parse for on every key).
 */
function inertEdit(
  src: string,
  base: number,
  lo: number,
  hi: number,
  from: number,
  to: number,
  text: string,
  code: boolean,
  leftOk: boolean,
  rightOk: boolean,
): boolean {
  if (text.length > INERT_MAX || to - from > INERT_MAX) return false;
  if (text.length === 0 && to === from) return false;
  if (text && !INERT_TEXT.test(text)) return false;
  const gone = src.slice(from, to);
  if (gone && !INERT_TEXT.test(gone)) return false;
  if (code) return true;
  let lineStart = src.lastIndexOf('\n', from - 1) + 1;
  if (lineStart < base) lineStart = base;
  if (STRUCTURAL_PREFIX.test(src.slice(lineStart, from))) return false;
  // The characters next to the edit: inside the run they must be plain; at its edge, what lies
  // beyond must be nothing, a line break or an atom (not a delimiter, which the text next to it can
  // change the meaning of).
  const before = from > lo ? src[from - 1] : undefined;
  const after = to < hi ? src[to] : undefined;
  if ((before === undefined ? !leftOk : !SAFE_NEIGHBOUR.test(before)) && before !== '\n') {
    return false;
  }
  if ((after === undefined ? !rightOk : !SAFE_NEIGHBOUR.test(after)) && after !== '\n') {
    return false;
  }
  // (Two spaces at the end of a line are a line break.)
  const lineEnd = after === '\n' || (after === undefined && (hi >= src.length || src[hi] === '\n'));
  if (lineEnd && (before === ' ' || text.endsWith(' '))) return false;
  let left = from;
  while (left > Math.max(lo, from - 256) && !/\s/.test(src[left - 1]!)) left -= 1;
  let right = to;
  while (right < Math.min(hi, to + 256) && !/\s/.test(src[right]!)) right += 1;
  const word = src.slice(left, from) + src.slice(to, right);
  if (WORD_SPECIALS.test(word)) return false;
  // A word that runs into a delimiter is not ended there: with the typed text it may now be the
  // start of an address (`www.` or `http://`) that would swallow what follows.
  if (((right >= hi && !rightOk) || (left <= lo && !leftOk)) && /[.:@/]/.test(word + text)) {
    return false;
  }
  return true;
}

export interface Patched {
  segment: Segment;
  /** Plain prose, written without a parse (see `inertEdit`): nothing else can have changed meaning. */
  inert: boolean;
  /** The change to the segment's source. */
  change: TextChange;
}

/**
 * Applies `edit` to `segment`, whose node becomes `node` (the same block after the edit): the
 * segment's source gets exactly the typed text (escaped as little as needed) and loses exactly the
 * deleted text. `null` when the edit is not of this simple kind or the result does not read back as
 * `node`.
 */
export function patchSegment(
  segment: Segment,
  segmentStart: number,
  node: PMNode,
  edit: TextEdit,
  labels?: ReadonlySet<string>,
): Patched | null {
  const rel = edit.from - segmentStart;
  const relTo = edit.to - segmentStart;
  const tb = segment.tbs.find((t) => rel >= t.pm && relTo <= t.pm + t.size);
  if (!tb || tb.map.length === 0) return null;
  const isCode = segment.node.type.name === 'code_block';
  const p = rel - tb.pm;
  const q = relTo - tb.pm;
  const key = marksKey(edit.marks);
  const host = hostToken(tb, p, q, key, edit.text.length > 0);
  if (!host) return null;
  const token = tb.map[host.index]!;
  const { k, kEnd } = host;
  const src = segment.src;
  const base = tb.s;

  // Where in the source: the deleted characters must be a plain copy (no escape or entity among
  // them, nothing between them), an insertion must not land between a backslash and its character.
  let from: number;
  let to: number;
  if (kEnd > k) {
    if (token.starts && token.ends) {
      for (let i = k; i < kEnd; i += 1) {
        const at = base + token.starts[i]!;
        if (token.ends[i]! - token.starts[i]! !== 1 || src[at - 1] === '\\') return null;
        if (i > k && token.starts[i]! !== token.ends[i - 1]!) return null;
      }
    }
    from = base + charStart(token, k);
    to = base + charEnd(token, kEnd - 1);
  } else {
    if (k < token.len) {
      if (token.starts && k > 0 && token.starts[k]! !== token.ends![k - 1]!) return null;
      from = base + charStart(token, k);
    } else from = base + token.e;
    to = from;
    if (src[from - 1] === '\\') return null;
  }

  const first = host.index === 0 || tb.map[host.index - 1]!.kind === 'break';
  const nextToken = tb.map[host.index + 1];
  const last = !nextToken || nextToken.kind === 'break';
  // Characters the source does not hold (spaces at a line's edges, which the serializer drops)
  // may be before the typed text only if they are leading, after it only if they are trailing:
  // typed text next to them would make them part of the line.
  if (token.starts && token.ends && !zeroWidthStays(token, k, kEnd, first, last)) return null;
  // A letter typed after a `<` that is there unescaped would make it the start of a tag: only the
  // serializer, which sees the whole text, escapes it.
  if (!isCode && edit.text !== '' && /^[a-zA-Z!/?]/.test(edit.text) && src[from - 1] === '<') {
    return null;
  }
  const hasLink = edit.marks.some((mark) => mark.type.name === 'link');
  // A line break the source does not hold (one that ends the block, or a heading's) cannot have text
  // typed after it as if it were there.
  const previous = tb.map[host.index - 1];
  if (previous?.kind === 'break' && previous.s === previous.e && edit.text !== '') return null;
  // What lies beyond the run's edge must be nothing at all (the start or end of the textblock), a
  // line break or an atom, not a delimiter that the text next to it can change the meaning of.
  const beside = (other: InlineToken | undefined, touching: boolean, atEdge: boolean) =>
    other ? touching && (other.kind === 'break' || other.kind === 'atom') : atEdge;
  const leftOk = beside(
    tb.map[host.index - 1],
    tb.map[host.index - 1]?.e === token.s,
    token.s === 0,
  );
  const rightOk = beside(nextToken, nextToken?.s === token.e, token.e === tb.e - tb.s);
  // (An indented code block cannot hold a blank first or last line: only fenced code is plain text.)
  const inert =
    !(isCode && segment.node.attrs['fence'] === 'indent') &&
    inertEdit(
      src,
      base,
      base + token.s,
      base + token.e,
      from,
      to,
      edit.text,
      isCode,
      leftOk,
      rightOk,
    );
  // Brackets may now spell a defined label: only the serializer sees the whole text to escape them.
  if (!inert && !isCode && labels && labels.size > 0 && src.slice(base, tb.e).includes('[')) {
    return null;
  }
  const levels: EscapeLevel[] = isCode ? [0] : inert ? [0] : [0, 1, 2];
  for (const level of levels) {
    const escaped = isCode
      ? { str: edit.text }
      : escapeText(edit.text, {
          level,
          lineStart: first && k === 0 && segment.node.type.name === 'paragraph',
          lineEnd: last && k === token.len,
          inLink: hasLink,
          trimEnd: false,
          // Spaces typed at the start of a line are not written: they mean nothing, and as many as
          // four would turn the paragraph into code.
          trimStart: first && allZeroBefore(token, k),
          local: true,
          following: to < src.length ? src[to] : undefined,
          labels,
        });
    const written = src.slice(0, from) + escaped.str + src.slice(to);
    if (inert || reads(written, node)) {
      const result = rebuild(
        segment,
        tb,
        host,
        p,
        q,
        from,
        to,
        escaped,
        written,
        node,
        edit.text.length,
      );
      return {
        segment: result,
        inert,
        change: { from, to, insertedLength: escaped.str.length },
      };
    }
  }
  return null;
}

function rebuild(
  segment: Segment,
  tb: TextblockInfo,
  host: Host,
  p: number,
  q: number,
  from: number,
  to: number,
  escaped: { str: string; starts?: Int32Array | undefined; ends?: Int32Array | undefined },
  written: string,
  node: PMNode,
  insLen: number,
): Segment {
  const token = tb.map[host.index]!;
  const { k, kEnd } = host;
  const pmDelta = insLen - (q - p);
  const srcDelta = escaped.str.length - (to - from);
  const base = tb.s;

  // The host token: its characters, with the deleted ones gone and the typed ones in.
  const len = token.len + pmDelta;
  let next: InlineToken;
  if (len === 0) {
    next = { ...token, len: 0, e: token.s };
  } else if (!token.starts && !escaped.starts) {
    next = { ...token, len, e: token.e + srcDelta };
  } else {
    const starts = new Int32Array(len);
    const ends = new Int32Array(len);
    let out = 0;
    for (let i = 0; i < k; i += 1) {
      starts[out] = charStart(token, i);
      ends[out] = charEnd(token, i);
      out += 1;
    }
    for (let i = 0; i < insLen; i += 1) {
      starts[out] = from - base + (escaped.starts ? escaped.starts[i]! : i);
      ends[out] = from - base + (escaped.ends ? escaped.ends[i]! : i + 1);
      out += 1;
    }
    for (let i = kEnd; i < token.len; i += 1) {
      starts[out] = charStart(token, i) + srcDelta;
      ends[out] = charEnd(token, i) + srcDelta;
      out += 1;
    }
    next = { ...token, len, s: starts[0]!, e: ends[len - 1]!, starts, ends };
  }

  const tokens: InlineToken[] = [];
  tb.map.forEach((t, i) => {
    if (i < host.index) tokens.push(t);
    else if (i === host.index) {
      // A token emptied by the deletion is dropped.
      if (next.len > 0) tokens.push(next);
    } else tokens.push(shiftToken(t, pmDelta, srcDelta));
  });
  const tbs = segment.tbs.map((t) => {
    if (t === tb) return { ...t, size: t.size + pmDelta, e: t.e + srcDelta, map: tokens };
    if (t.pm > tb.pm) return { ...t, pm: t.pm + pmDelta, s: t.s + srcDelta, e: t.e + srcDelta };
    return t;
  });
  return { node, gap: segment.gap, src: written, tbs };
}
