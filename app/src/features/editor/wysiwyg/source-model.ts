import type { Node as PMNode } from 'prosemirror-model';

import { diffChange, type TextChange } from '@/features/editor/lib/anchors';

import { pmToSrc, srcToPm, type Edge } from './inline-map';
import { patchSegment, type TextEdit } from './patch';
import { parseDocument, virtualSegment, type Segment, type TextblockInfo } from './parse';
import { detectStyle, serializeVerified, type SerializeStyle } from './serialize';

/**
 * The Markdown source of the open section and its relation to the editor document (issue #182,
 * phase 5). The source string is the truth; the editor document is a view of it:
 *
 * - `segments` hold, per top-level block, its exact source, the exact whitespace before it and the
 *   position maps of its textblocks;
 * - an editor change replaces only the top-level blocks that changed (found by node identity,
 *   which ProseMirror preserves for everything an edit did not touch): their source is written by
 *   the serializer and verified, everything else keeps its original slice byte for byte;
 * - `update` therefore yields one contiguous source change (`TextChange`) that anchors are mapped
 *   through exactly as the Source view's change sets do.
 *
 * An empty top-level paragraph has no source at all (a *virtual* segment): pressing Enter at the
 * end of a block does not change the draft until something is typed.
 */

export interface UpdateOk {
  ok: true;
  /** The new source differs from the old one by this change; `null` when the text is unchanged. */
  change: TextChange | null;
  text: string;
}
export interface UpdateRefused {
  ok: false;
}
export type UpdateResult = UpdateOk | UpdateRefused;

const isVirtual = (segment: Segment) =>
  segment.src === '' && segment.node.type.name === 'paragraph';

/** A separator that keeps two blocks apart: at least one blank line. */
function separator(candidate: string | undefined): string {
  return candidate && /\n[ \t]*\n/.test(candidate) ? candidate : '\n\n';
}

/** What makes a list a list of its own in the source: bullets by marker, numbered lists by delimiter. */
function listKey(segment: Segment): string | null {
  const type = segment.node.type.name;
  if (type === 'bullet_list') return `ul${segment.src[0] ?? '-'}`;
  if (type === 'ordered_list') return `ol${/^\d+([.)])/.exec(segment.src)?.[1] ?? '.'}`;
  return null;
}

/** Whether a list's source uses the marker its node says (a list kept apart from its neighbour uses the other). */
function listMarkerMatches(node: PMNode, src: string): boolean {
  if (node.type.name === 'bullet_list') return src[0] === node.attrs['marker'];
  if (node.type.name === 'ordered_list') {
    return (/^\d+([.)])/.exec(src)?.[1] ?? '.') === node.attrs['delim'];
  }
  return true;
}

/** The segment written again with the other marker of its kind (so it does not merge with the list before it). */
function withOtherMarker(segment: Segment, style: SerializeStyle): Segment | null {
  const { node } = segment;
  const attrs =
    node.type.name === 'bullet_list'
      ? { ...node.attrs, marker: segment.src[0] === '-' ? '*' : '-' }
      : { ...node.attrs, delim: /^\d+\)/.test(segment.src) ? '.' : ')' };
  const other = node.type.create(attrs, node.content, node.marks);
  const written = serializeVerified(other, style);
  return written ? { node, gap: segment.gap, src: written.src, tbs: written.tbs } : null;
}

interface WindowMemory {
  segments: Segment[];
  prev: PMNode | null;
  next: PMNode | null;
  /** The whitespace in front of the block after the window, as it was with these blocks there. */
  nextGap: string | null;
  /** The block after the window as it was written then (it may have had its list marker changed meanwhile). */
  nextSegment: Segment | null;
  /** The blocks that stood in the window on the other side of the change (which of several equal windows is meant). */
  other: PMNode[];
}

/** Equal blocks; the cheap checks first (this runs against hundreds of remembered blocks per edit). */
const sameBlock = (a: PMNode, b: PMNode) =>
  a.nodeSize === b.nodeSize && a.type === b.type && a.eq(b);

const sameNode = (a: PMNode | null, b: PMNode | null) =>
  a === null || b === null ? a === b : a.eq(b);

function countAtoms(node: PMNode): number {
  let count = node.type.name === 'atom_block' ? 1 : 0;
  node.descendants((child) => {
    if (child.type.name === 'atom_inline' || child.type.name === 'atom_block') count += 1;
    return true;
  });
  return count;
}

export class SourceModel {
  segments: Segment[];
  tail: string;
  text: string;
  style: SerializeStyle;
  /** Absolute source offset where each segment's source starts / ends. */
  private srcStart: number[] = [];
  private srcEnd: number[] = [];
  /** Editor position before each segment's node. */
  private pmStart: number[] = [];
  private pmSize = 0;
  /** Segments the editor wrote since they were last read from their source. */
  private touched = new WeakSet<Segment>();
  /**
   * Blocks the editor replaced lately, newest first, with the block that replaced each. A block that
   * comes back equal to one of them (an undo, a redo) gets its exact source back - not what the
   * serializer would write for it; the block it replaces tells which of several equal ones is meant
   * (the same text can have been written escaped and unescaped at different times).
   */
  private recent: {
    node: PMNode;
    src: string;
    tbs: TextblockInfo[];
    after: PMNode | null;
    /** Outside the cap that thins out the middle of a long run of typing. */
    pinned: boolean;
  }[] = [];
  /** The block the last text patch produced (see `recent`). */
  private lastPatched: PMNode | null = null;
  /** Groups of blocks the editor added or removed lately, with their neighbours (for an exact undo). */
  private windows: WindowMemory[] = [];

  constructor(text: string, parsed = parseDocument(text)) {
    this.text = text;
    this.segments = parsed.segments;
    this.tail = parsed.tail;
    this.style = detectStyle(text);
    this.recompute();
  }

  private recompute() {
    let src = 0;
    let pm = 0;
    this.srcStart = [];
    this.srcEnd = [];
    this.pmStart = [];
    for (const segment of this.segments) {
      src += segment.gap.length;
      this.srcStart.push(src);
      src += segment.src.length;
      this.srcEnd.push(src);
      this.pmStart.push(pm);
      pm += segment.node.nodeSize;
    }
    this.pmSize = pm;
  }

  /** Joins gaps, sources and tail: the text the segments stand for (the model keeps `text` in step incrementally). */
  join(): string {
    return this.segments.map((segment) => segment.gap + segment.src).join('') + this.tail;
  }

  /**
   * Brings the source in step with `doc` after an editor transaction. Returns the source change, or
   * `{ ok: false }` when an edited block cannot be written as Markdown that reads back as itself
   * (the model is then unchanged and the caller drops the transaction).
   */
  update(doc: PMNode, edit: TextEdit | null = null, preset: Segment | null = null): UpdateResult {
    const old = this.segments;
    const n = doc.childCount;
    let i = 0;
    while (i < old.length && i < n && old[i]!.node === doc.child(i)) i += 1;
    let j = 0;
    while (
      j < old.length - i &&
      j < n - i &&
      old[old.length - 1 - j]!.node === doc.child(n - 1 - j)
    ) {
      j += 1;
    }
    const oldEnd = old.length - j;
    if (i === oldEnd && i === n - j) return { ok: true, change: null, text: this.text };

    const newNodes: PMNode[] = [];
    for (let k = i; k < n - j; k += 1) newNodes.push(doc.child(k));
    const oldWindow = old.slice(i, oldEnd);

    // The real (non-virtual) neighbours of the window.
    let prev = i - 1;
    while (prev >= 0 && isVirtual(old[prev]!)) prev -= 1;
    let next = oldEnd;
    while (next < old.length && isVirtual(old[next]!)) next += 1;
    const prevReal = prev >= 0 ? old[prev]! : null;
    const nextReal = next < old.length ? old[next]! : null;
    const oldFirstReal = oldWindow.find((segment) => !isVirtual(segment)) ?? null;

    const fallbackGap = separator(oldFirstReal?.gap || nextReal?.gap || prevReal?.gap);
    const oldReals = oldWindow.filter((segment) => !isVirtual(segment));
    const newReals = newNodes.filter(
      (node) => !(node.type.name === 'paragraph' && node.content.size === 0),
    );
    const fresh: Segment[] = [];
    // Typing inside one run of text of one block: the source gets exactly the typed text.
    let patched: Segment | null = null;
    if (
      edit &&
      oldWindow.length === 1 &&
      newNodes.length === 1 &&
      oldFirstReal === oldWindow[0] &&
      oldFirstReal.tbs.length > 0 &&
      newNodes[0]!.content.size > 0 &&
      oldFirstReal.node.sameMarkup(newNodes[0]!) &&
      edit.from >= this.pmStart[i]! &&
      edit.to <= this.pmStart[i]! + oldFirstReal.node.nodeSize &&
      // A block that comes back as one of the recent ones (an undo) gets its exact source instead.
      !this.recent.some((entry) => sameBlock(entry.node, newNodes[0]!))
    ) {
      patched = patchSegment(oldFirstReal, this.pmStart[i]!, newNodes[0]!, edit);
    }
    // A block re-read from its own source (`reconcilable`): same source, the editor's node replaced.
    if (
      preset &&
      oldWindow.length === 1 &&
      newNodes.length === 1 &&
      oldFirstReal === oldWindow[0]
    ) {
      patched = { ...preset, gap: oldFirstReal.gap };
    }

    // Blocks that come back as they were as a group (an undo, a redo) get their exact source and the
    // exact whitespace around them back (and so does the block after them, see below).
    let remembered: WindowMemory | null = null;
    if (!patched && !preset) {
      remembered =
        this.windows.find(
          (entry) =>
            entry.segments.length === newReals.length &&
            entry.segments.every((segment, k) => sameBlock(segment.node, newReals[k]!)) &&
            entry.other.length === oldReals.length &&
            entry.other.every((node, k) => sameBlock(node, oldReals[k]!.node)) &&
            sameNode(entry.prev, prevReal?.node ?? null) &&
            sameNode(entry.next, nextReal?.node ?? null),
        ) ?? null;
    }

    let realIndex = 0;
    for (const node of patched ? [] : newNodes) {
      if (node.type.name === 'paragraph' && node.content.size === 0) {
        fresh.push({ ...virtualSegment(), node });
        continue;
      }
      const index = realIndex;
      realIndex += 1;
      if (remembered) {
        fresh.push({ ...remembered.segments[index]!, node });
        continue;
      }
      const replaced = oldReals[index]?.node ?? null;
      const known =
        (replaced
          ? this.recent.find(
              (entry) =>
                entry.after !== null && sameBlock(entry.node, node) && entry.after.eq(replaced),
            )
          : undefined) ?? this.recent.find((entry) => sameBlock(entry.node, node));
      // (A remembered list written with the other marker, to stay apart from a neighbour that is no
      // longer there, is written again with its own.)
      const usable = known && listMarkerMatches(node, known.src) ? known : undefined;
      const written = usable ?? serializeVerified(node, this.style);
      if (!written) return { ok: false };
      let gap: string;
      if (index > 0) gap = oldReals[index]?.gap ?? fallbackGap;
      else if (oldFirstReal) gap = oldFirstReal.gap;
      else if (!prevReal && nextReal) gap = nextReal.gap;
      else if (!prevReal) gap = '';
      else gap = fallbackGap;
      fresh.push({ node, gap, src: written.src, tbs: written.tbs });
    }

    if (patched) fresh.push(patched);

    // Two lists that touch with the same marker would be read as one list: the later one is
    // written with the other marker (it may be the block after the window).
    let nextFlipped: Segment | null = null;
    let before: Segment | null = prevReal;
    for (let k = 0; k < fresh.length; k += 1) {
      const segment = fresh[k]!;
      if (isVirtual(segment)) continue;
      const key = listKey(segment);
      if (key && before && listKey(before) === key) {
        fresh[k] = withOtherMarker(segment, this.style) ?? segment;
      }
      before = fresh[k]!;
    }
    if (nextReal && before) {
      const key = listKey(nextReal);
      if (key && listKey(before) === key) nextFlipped = withOtherMarker(nextReal, this.style);
    }
    // The block after the window comes back as it was written (a list that had been given another
    // marker to stay apart from the one before it) when that is no longer needed.
    if (
      remembered?.nextSegment &&
      nextReal &&
      !nextFlipped &&
      nextReal.src !== remembered.nextSegment.src &&
      nextReal.node.eq(remembered.nextSegment.node) &&
      !(
        listKey(remembered.nextSegment) &&
        before &&
        listKey(before) === listKey(remembered.nextSegment)
      )
    ) {
      nextFlipped = remembered.nextSegment;
    }
    for (const segment of fresh) this.touched.add(segment);

    // The gap before the next real block: kept, except where the window took over its leading
    // whitespace, or gave it up (blocks removed in front of it).
    const freshReals = fresh.filter((segment) => !isVirtual(segment));
    let nextGap = nextReal?.gap ?? '';
    if (nextReal) {
      if (remembered && remembered.nextGap !== null) nextGap = remembered.nextGap;
      else if (freshReals.length === 0 && oldFirstReal) nextGap = oldFirstReal.gap;
      else if (!oldFirstReal && !prevReal && freshReals.length > 0) nextGap = fallbackGap;
    }

    // The source region that changes: from the end of the real block before the window to the start
    // of the real block after it (gaps included), or to the window's last block when nothing follows.
    const regionStart = prev >= 0 ? this.srcEnd[prev]! : 0;
    let regionEnd: number;
    if (nextReal) regionEnd = nextFlipped ? this.srcEnd[next]! : this.srcStart[next]!;
    else {
      const lastOld = [...oldWindow].reverse().findIndex((segment) => !isVirtual(segment));
      regionEnd = lastOld < 0 ? regionStart : this.srcEnd[oldEnd - 1 - lastOld]!;
    }
    const oldRegion = this.text.slice(regionStart, regionEnd);
    const newRegion =
      freshReals.map((segment) => segment.gap + segment.src).join('') +
      (nextReal ? nextGap : '') +
      (nextFlipped ? nextFlipped.src : '');

    const nextSegments = [...old.slice(0, i), ...fresh, ...old.slice(oldEnd)];
    if (nextReal && (nextFlipped || nextGap !== nextReal.gap)) {
      const at = nextSegments.indexOf(nextReal);
      nextSegments[at] = { ...(nextFlipped ?? nextReal), gap: nextGap };
    }
    const nextText = this.text.slice(0, regionStart) + newRegion + this.text.slice(regionEnd);

    const local = diffChange(oldRegion, newRegion);
    // (The first version of a block before a run of typed characters is kept apart from the cap: a
    // run is undone as one, and that version is what it comes back to.)
    const continuesRun = !!patched && oldFirstReal?.node === this.lastPatched;
    this.lastPatched = patched ? patched.node : null;
    oldReals.forEach((segment, k) => {
      if (segment.node.type.name === 'atom_block') return;
      this.recent.unshift({
        pinned: !continuesRun,
        node: segment.node,
        src: segment.src,
        tbs: segment.tbs,
        after: freshReals[k]?.node ?? null,
      });
    });
    // Remember both sides of a change in the number of blocks, with the whitespace around them.
    if (oldReals.length !== freshReals.length || nextFlipped) {
      const context = { prev: prevReal?.node ?? null, next: nextReal?.node ?? null };
      this.windows.unshift(
        {
          ...context,
          segments: oldReals,
          nextGap: nextReal?.gap ?? null,
          nextSegment: nextReal,
          other: freshReals.map((segment) => segment.node),
        },
        {
          ...context,
          segments: freshReals,
          nextGap: nextReal ? nextGap : null,
          nextSegment: nextFlipped ?? nextReal,
          other: oldReals.map((segment) => segment.node),
        },
      );
      if (this.windows.length > 128) this.windows.length = 128;
    }
    if (this.recent.length > 512) {
      let loose = 0;
      this.recent = this.recent.filter((entry) => entry.pinned || (loose += 1) <= 384);
      if (this.recent.length > 1024) this.recent.length = 1024;
    }
    this.segments = nextSegments;
    this.text = nextText;
    this.recompute();
    return {
      ok: true,
      text: nextText,
      change: local
        ? {
            from: regionStart + local.from,
            to: regionStart + local.to,
            insertedLength: local.insertedLength,
          }
        : null,
    };
  }

  /**
   * Blocks the editor has written whose source now reads as more than the editor shows: text typed
   * as `$x$` or `[@key]` stays literal while it is typed and becomes the formula or the citation
   * when the block is read again. Returns the blocks as read from their source, to be swapped in
   * (`update` with `preset`); the source itself does not change.
   */
  reconcilable(): { pos: number; segment: Segment }[] {
    const out: { pos: number; segment: Segment }[] = [];
    this.segments.forEach((segment, index) => {
      if (!this.touched.has(segment) || segment.src === '' || segment.node.isAtom) return;
      const parsed = parseDocument(segment.src, { trailingParagraph: false }).segments;
      if (parsed.length !== 1) return;
      const read = parsed[0]!;
      if (countAtoms(read.node) !== countAtoms(segment.node)) {
        out.push({ pos: this.pmStart[index]!, segment: { ...read, gap: segment.gap } });
      }
    });
    this.touched = new WeakSet();
    return out;
  }

  // ---- positions ----------------------------------------------------------------------------

  /** Index of the segment whose node contains editor position `pos` (the last one for the end). */
  private segmentAt(pos: number): number {
    let lo = 0;
    let hi = this.segments.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.pmStart[mid]! <= pos) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  /** End of the last real block at or before segment `k` (where a virtual block "is" in the source). */
  private endBefore(k: number): number {
    for (let m = k - 1; m >= 0; m -= 1) if (!isVirtual(this.segments[m]!)) return this.srcEnd[m]!;
    return 0;
  }

  /**
   * Source offset (UTF-16) of editor position `pos`. `'start'` is for the start of a range (it
   * hugs the text after `pos`), `'end'` for its end (it hugs the text before `pos`).
   */
  posToSrc(pos: number, edge: Edge): number {
    if (this.segments.length === 0) return 0;
    const clamped = Math.max(0, Math.min(pos, this.pmSize));
    const k = this.segmentAt(clamped);
    const segment = this.segments[k]!;
    const rel = clamped - this.pmStart[k]!;
    const base = this.srcStart[k]!;
    if (isVirtual(segment)) return this.endBefore(k);
    if (rel <= 0) return edge === 'start' ? base : this.endBefore(k);
    if (rel >= segment.node.nodeSize) return this.srcEnd[k]!;
    const tbs = segment.tbs;
    if (tbs.length === 0) return edge === 'start' ? base : this.srcEnd[k]!;
    // The textblock containing `rel`, or the nearest one on the side the edge hugs.
    let inside: TextblockInfo | null = null;
    let before: TextblockInfo | null = null;
    let after: TextblockInfo | null = null;
    for (const tb of tbs) {
      if (rel >= tb.pm && rel <= tb.pm + tb.size) {
        inside = tb;
        break;
      }
      if (tb.pm + tb.size < rel) before = tb;
      else if (!after) after = tb;
    }
    if (inside) return base + inside.s + pmToSrc(inside.map, rel - inside.pm, edge);
    if (edge === 'start' && after) return base + after.s + pmToSrc(after.map, 0, 'start');
    if (before) return base + before.s + pmToSrc(before.map, before.size, 'end');
    if (after) return base + after.s;
    return base;
  }

  /**
   * Editor position of source offset `offset`, inside a textblock where there is one (for placing
   * a caret), else next to the atom or block that holds it.
   */
  srcToPos(offset: number, edge: Edge): number {
    if (this.segments.length === 0) return 0;
    let k = this.segments.length - 1;
    for (let m = 0; m < this.segments.length; m += 1) {
      if (offset <= this.srcEnd[m]! && !isVirtual(this.segments[m]!)) {
        k = m;
        break;
      }
    }
    // A virtual trailing paragraph, or an offset past every block, lands in the last real block.
    const segment = this.segments[k]!;
    const base = this.srcStart[k]!;
    const rel = offset - base;
    if (rel <= 0 && segment.tbs.length === 0) return this.pmStart[k]!;
    if (segment.tbs.length === 0) {
      return rel >= segment.src.length
        ? this.pmStart[k]! + segment.node.nodeSize
        : this.pmStart[k]!;
    }
    let best = segment.tbs[0]!;
    for (const tb of segment.tbs) {
      if (rel >= tb.s) best = tb;
      if (rel < tb.e) break;
    }
    const inline = Math.max(0, Math.min(rel - best.s, best.e - best.s));
    const local = srcToPm(best.map, inline, edge);
    return this.pmStart[k]! + best.pm + Math.min(local, best.size);
  }

  /**
   * The parts of the editor a source range `[start, end)` covers: text ranges (editor positions,
   * one per textblock) and the positions of atoms (inline and block) it touches.
   */
  rangesForSource(
    start: number,
    end: number,
  ): { text: { from: number; to: number }[]; atoms: number[] } {
    const text: { from: number; to: number }[] = [];
    const atoms: number[] = [];
    if (end <= start) return { text, atoms };
    // First segment that ends after `start`.
    let lo = 0;
    let hi = this.segments.length - 1;
    let first = this.segments.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.srcEnd[mid]! > start) {
        first = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    for (let k = first; k < this.segments.length && this.srcStart[k]! < end; k += 1) {
      const segment = this.segments[k]!;
      if (isVirtual(segment)) continue;
      const base = this.srcStart[k]!;
      if (segment.tbs.length === 0) {
        atoms.push(this.pmStart[k]!);
        continue;
      }
      for (const tb of segment.tbs) {
        const tbStart = base + tb.s;
        const tbEnd = base + tb.e;
        if (tbEnd <= start || tbStart >= end) continue;
        const a = Math.max(start, tbStart) - tbStart;
        const b = Math.min(end, tbEnd) - tbStart;
        const from = srcToPm(tb.map, a, 'start');
        const to = srcToPm(tb.map, b, 'end');
        for (const token of tb.map) {
          if (token.kind !== 'atom') continue;
          if (token.e > a && token.s < b) atoms.push(this.pmStart[k]! + tb.pm + token.pm);
        }
        if (to > from) {
          text.push({
            from: this.pmStart[k]! + tb.pm + from,
            to: this.pmStart[k]! + tb.pm + to,
          });
        }
      }
    }
    return { text, atoms };
  }

  /** The top-level block holding source offset `offset` (the nearest one for whitespace): its editor position and source range. */
  blockAt(offset: number): { pos: number; start: number; end: number } | null {
    for (let k = 0; k < this.segments.length; k += 1) {
      if (!isVirtual(this.segments[k]!) && offset <= this.srcEnd[k]!) {
        return { pos: this.pmStart[k]!, start: this.srcStart[k]!, end: this.srcEnd[k]! };
      }
    }
    return null;
  }
}
