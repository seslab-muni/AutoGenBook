import type { Node as PMNode } from 'prosemirror-model';

import type { TextChange } from '@/features/editor/lib/anchors';

import { pmToSrc, srcToPm, type Edge } from './inline-map';
import { blockFingerprint } from './equivalence';
import { diffHunks } from './hunks';
import { patchSegment, type Patched, type TextEdit } from './patch';
import {
  listMarkerOffsets,
  parseDocument,
  virtualSegment,
  type Segment,
  type TextblockInfo,
} from './parse';
import { isBlankParagraph } from './equivalence';
import { detectStyle, LEVELS, serializeVerified, type SerializeStyle } from './serialize';

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
  /**
   * The new source differs from the old one by these changes: separate hunks in the coordinates of
   * the old source, ascending (map a position through them from the last to the first). Empty when
   * the text is unchanged.
   */
  changes: TextChange[];
  text: string;
}
export interface UpdateRefused {
  ok: false;
}
export type UpdateResult = UpdateOk | UpdateRefused;

const isVirtual = (segment: Segment) =>
  segment.src === '' && segment.node.type.name === 'paragraph';

const hasBlankLine = (gap: string) => /\n[ \t]*\n/.test(gap);

/** A separator that keeps two blocks apart: at least one blank line. */
function separator(candidate: string | undefined): string {
  return candidate && hasBlankLine(candidate) ? candidate : '\n\n';
}

const LIST_START = /^( {0,3})([-+*]|\d{1,9}([.)]))(?=[ \t\r\n]|$)/;

/**
 * What makes a list a list of its own in the source: bullets by marker, numbered lists by delimiter
 * (two lists that touch with the same key are read as one). Lists the editor shows as atoms (task
 * lists) count, and so do lists indented by up to three spaces.
 */
function listKey(segment: Segment): string | null {
  const type = segment.node.type.name;
  if (type !== 'bullet_list' && type !== 'ordered_list' && type !== 'atom_block') return null;
  if (type === 'atom_block' && segment.node.attrs['kind'] !== 'raw') return null;
  const m = LIST_START.exec(segment.src);
  if (!m) return null;
  return m[3] ? `ol${m[3]}` : `ul${m[2]}`;
}

/** Whether a list's source uses the marker its node says (a list kept apart from its neighbour uses the other). */
function listMarkerMatches(node: PMNode, src: string): boolean {
  const m = LIST_START.exec(src);
  if (node.type.name === 'bullet_list') return m?.[2] === node.attrs['marker'];
  if (node.type.name === 'ordered_list') return (m?.[3] ?? '.') === node.attrs['delim'];
  return true;
}

/**
 * The list with the marker of every item changed to another one of its kind (so it does not merge
 * with the list next to it): the marker characters and nothing else, so the rest of the list keeps
 * its exact source - and its offsets, since a marker is one character either way. `avoid` are the
 * keys (`listKey`) of the lists it must stay apart from.
 */
function withOtherMarker(segment: Segment, avoid: readonly (string | null)[]): Segment | null {
  const found = listMarkerOffsets(segment.src);
  if (!found) return null;
  const choices = found.ordered ? ['.', ')'] : ['-', '*', '+'];
  const prefix = found.ordered ? 'ol' : 'ul';
  const target = choices.find((c) => !avoid.includes(`${prefix}${c}`));
  if (!target) return null;
  let src = '';
  let at = 0;
  for (const offset of found.offsets) {
    src += segment.src.slice(at, offset) + target;
    at = offset + 1;
  }
  return { ...segment, src: src + segment.src.slice(at) };
}

/** What replaced the blocks: an edit, an undo, a redo. */
type Origin = 'edit' | 'undo' | 'redo';

/**
 * The remembered entry for an undo or a redo. An undo brings back what an edit (or a redo) took
 * away, a redo what an undo took away: of several equal blocks written differently (escaped and
 * not) that is the one to prefer; any other match is the fallback.
 */
function recall<T extends { by: Origin }>(
  list: readonly T[],
  matches: (entry: T) => boolean,
  history: Origin | false,
): T | undefined {
  let fallback: T | undefined;
  for (const entry of list) {
    if (!matches(entry)) continue;
    if (!history) return entry;
    const wanted = history === 'undo' ? entry.by !== 'undo' : entry.by === 'undo';
    if (wanted) return entry;
    fallback ??= entry;
  }
  return fallback;
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
  bytes: number;
  by: Origin;
}

interface RecentEntry {
  node: PMNode;
  src: string;
  tbs: TextblockInfo[];
  after: PMNode | null;
  /** Outside the cap that thins out the middle of a long run of typing. */
  pinned: boolean;
  bytes: number;
  by: Origin;
}

/** What the model remembers for exact undo is bounded by count and by size (a block can be huge). */
const RECENT_ENTRIES = 1024;
const RECENT_LOOSE_ENTRIES = 384;
const RECENT_BYTES = 6_000_000;
const RECENT_LOOSE_BYTES = 2_000_000;
const WINDOW_ENTRIES = 128;
const WINDOW_BYTES = 6_000_000;

/** Edits are verified in the context of their neighbours up to this much source. */
const CONTEXT_LIMIT = 48_000;

/** Equal blocks; the cheap checks first (this runs against hundreds of remembered blocks per edit). */
const sameBlock = (a: PMNode, b: PMNode) =>
  a.nodeSize === b.nodeSize && a.type === b.type && a.eq(b);

const sameNode = (a: PMNode | null, b: PMNode | null) =>
  a === null || b === null ? a === b : a.eq(b);

const fingerprints = new WeakMap<PMNode, string>();
function fingerprintOf(node: PMNode): string {
  let value = fingerprints.get(node);
  if (value === undefined) {
    value = JSON.stringify(blockFingerprint(node));
    fingerprints.set(node, value);
  }
  return value;
}

/** How hard `update` tries to write the blocks it must write (see the escalation in `update`). */
interface Attempt {
  /** First serializer level to try (an index into `LEVELS`). */
  from: number;
  /** Sources the model remembers or the patch produces are used; else the serializer writes everything. */
  exact: boolean;
  /** Blocks are kept apart by a blank line. */
  widen: boolean;
}

interface Built {
  fresh: Segment[];
  freshReals: Segment[];
  patched: Patched | null;
  remembered: WindowMemory | null;
  nextFlipped: Segment | null;
  nextGap: string;
  /** Highest serializer level that was needed (-1: none was). */
  maxLevel: number;
  usedExact: boolean;
  /** Some gap next to the written blocks is not a blank line. */
  nonBlank: boolean;
  /** The written blocks read back, next to their neighbours, as the editor shows them. */
  verified: boolean;
}

/** Normalised labels of the link definitions and footnote definitions among the blocks. */
function labelsOf(segments: readonly Segment[]): Set<string> {
  const out = new Set<string>();
  for (const segment of segments) {
    const { node } = segment;
    if (node.type.name !== 'atom_block') continue;
    const kind = node.attrs['kind'];
    if (kind !== 'definition' && kind !== 'footnote') continue;
    for (const m of segment.src.matchAll(/^ {0,3}\[([^\]]+)\]:/gm)) {
      out.add(m[1]!.trim().toLowerCase().replace(/\s+/g, ' '));
    }
  }
  return out;
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
  /**
   * Blocks the editor replaced lately, newest first, with the block that replaced each. A block that
   * comes back equal to one of them (an undo, a redo) gets its exact source back - not what the
   * serializer would write for it; the block it replaces tells which of several equal ones is meant
   * (the same text can have been written escaped and unescaped at different times).
   */
  private recent: RecentEntry[] = [];
  private recentBytes = 0;
  /** The block the last text patch produced (see `recent`). */
  private lastPatched: PMNode | null = null;
  /** Groups of blocks the editor added or removed lately, with their neighbours (for an exact undo). */
  private windows: WindowMemory[] = [];
  private windowBytes = 0;

  constructor(text: string, parsed = parseDocument(text)) {
    this.text = text;
    this.segments = parsed.segments;
    this.tail = parsed.tail;
    this.style = { ...detectStyle(text), labels: labelsOf(this.segments) };
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
   * Brings the source in step with `doc` after an editor transaction. Returns the source changes, or
   * `{ ok: false }` when an edited block cannot be written as Markdown that reads back, next to the
   * blocks around it, as the editor shows it (the model is then unchanged and the caller drops the
   * transaction). `history` is an undo or a redo: the blocks come back as they were written.
   *
   * What is written is verified twice: each block alone (it reads back as itself), and, when blocks
   * are next to others, the written blocks with their neighbours (the same blocks come out: a list
   * item deleted down to `-` must not turn the paragraph before it into a heading, a line typed
   * under a list must not become part of the list). If that fails the blocks are first kept apart by
   * a blank line, then written with stronger escapes, then the edit is refused.
   */
  update(doc: PMNode, edit: TextEdit | null = null, history: Origin | false = false): UpdateResult {
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
    if (i === oldEnd && i === n - j) return { ok: true, changes: [], text: this.text };

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
    const newReals = newNodes.filter((node) => !isBlankParagraph(node));

    const build = (attempt: Attempt): Built | null => {
      const fresh: Segment[] = [];
      let maxLevel = -1;
      let usedExact = false;
      // Typing inside one run of text of one block: the source gets exactly the typed text.
      let patched: Patched | null = null;
      if (
        attempt.exact &&
        !history &&
        edit &&
        oldWindow.length === 1 &&
        newNodes.length === 1 &&
        oldFirstReal === oldWindow[0] &&
        oldFirstReal.tbs.length > 0 &&
        !isBlankParagraph(newNodes[0]!) &&
        newNodes[0]!.content.size > 0 &&
        oldFirstReal.node.sameMarkup(newNodes[0]!) &&
        edit.from >= this.pmStart[i]! &&
        edit.to <= this.pmStart[i]! + oldFirstReal.node.nodeSize
      ) {
        patched = patchSegment(
          oldFirstReal,
          this.pmStart[i]!,
          newNodes[0]!,
          edit,
          this.style.labels,
        );
      }

      // Blocks that come back as they were as a group (an undo, a redo) get their exact source and the
      // exact whitespace around them back (and so does the block after them, see below).
      let remembered: WindowMemory | null = null;
      if (attempt.exact && !patched) {
        remembered =
          recall(
            this.windows,
            (entry) =>
              entry.segments.length === newReals.length &&
              entry.segments.every((segment, k) => sameBlock(segment.node, newReals[k]!)) &&
              entry.other.length === oldReals.length &&
              entry.other.every((node, k) => sameBlock(node, oldReals[k]!.node)) &&
              sameNode(entry.prev, prevReal?.node ?? null) &&
              sameNode(entry.next, nextReal?.node ?? null),
            history,
          ) ?? null;
      }

      let realIndex = 0;
      for (const node of patched ? [] : newNodes) {
        if (isBlankParagraph(node)) {
          fresh.push({ ...virtualSegment(), node });
          continue;
        }
        const index = realIndex;
        realIndex += 1;
        let gap: string;
        if (index > 0) gap = oldReals[index]?.gap ?? fallbackGap;
        else if (oldFirstReal) gap = oldFirstReal.gap;
        else if (!prevReal && nextReal) gap = nextReal.gap;
        else if (!prevReal) gap = '';
        else gap = fallbackGap;
        if (remembered) {
          usedExact = true;
          fresh.push({ ...remembered.segments[index]!, node });
          continue;
        }
        const replaced = oldReals[index]?.node ?? null;
        const known = attempt.exact
          ? ((replaced
              ? recall(
                  this.recent,
                  (entry) =>
                    entry.after !== null && sameBlock(entry.node, node) && entry.after.eq(replaced),
                  history,
                )
              : undefined) ?? recall(this.recent, (entry) => sameBlock(entry.node, node), history))
          : undefined;
        // (A remembered list written with the other marker, to stay apart from a neighbour that is no
        // longer there, is written again with its own.)
        const usable = known && listMarkerMatches(node, known.src) ? known : undefined;
        if (usable) {
          usedExact = true;
          fresh.push({ node, gap, src: usable.src, tbs: usable.tbs });
          continue;
        }
        // (A new block does not take over the indentation another block had.)
        gap = gap.replace(/[ \t]+$/, '');
        const written = serializeVerified(node, this.style, attempt.from);
        if (!written) {
          return null;
        }
        maxLevel = Math.max(maxLevel, written.level);
        fresh.push({ node, gap, src: written.src, tbs: written.tbs });
      }
      if (patched) {
        usedExact = true;
        fresh.push(patched.segment);
      }

      // Blocks kept apart by a blank line.
      if (attempt.widen) {
        let first = true;
        fresh.forEach((segment, k) => {
          if (isVirtual(segment)) return;
          if (!first || prevReal) fresh[k] = { ...segment, gap: separator(segment.gap) };
          first = false;
        });
      }

      // Two lists that touch with the same marker would be read as one list: the later one gets
      // another marker (it may be the block after the window, or - if that one is an atom, whose
      // source the document shows as it is - the last list written here).
      let nextFlipped: Segment | null = null;
      const nextKey = nextReal ? listKey(nextReal) : null;
      const nextIsAtom = nextReal?.node.type.name === 'atom_block';
      const lastReal = fresh.map((s) => !isVirtual(s)).lastIndexOf(true);
      let before: Segment | null = prevReal;
      for (let k = 0; k < fresh.length; k += 1) {
        const segment = fresh[k]!;
        if (isVirtual(segment)) continue;
        const key = listKey(segment);
        const touchesAtom = nextIsAtom && k === lastReal && key !== null && key === nextKey;
        if (key && ((before && listKey(before) === key) || touchesAtom)) {
          const avoid = [before ? listKey(before) : null, touchesAtom ? nextKey : null];
          const flipped = withOtherMarker(segment, avoid);
          if (!flipped) return null;
          fresh[k] = flipped;
        }
        before = fresh[k]!;
      }
      if (nextReal && before && !nextIsAtom) {
        const key = listKey(nextReal);
        if (key && listKey(before) === key) {
          nextFlipped = withOtherMarker(nextReal, [listKey(before)]);
          if (!nextFlipped) return null;
        }
      }
      // An indented code block after a list or a quote would be read as part of it: written fenced.
      if (
        !nextFlipped &&
        nextReal &&
        attempt.from >= 1 &&
        nextReal.node.type.name === 'code_block' &&
        nextReal.node.attrs['fence'] === 'indent'
      ) {
        const fenced = serializeVerified(nextReal.node, this.style, attempt.from);
        if (fenced) nextFlipped = { ...nextReal, src: fenced.src, tbs: fenced.tbs };
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

      // The gap before the next real block: kept, except where the window took over its leading
      // whitespace, or gave it up (blocks removed in front of it).
      const freshReals = fresh.filter((segment) => !isVirtual(segment));
      let nextGap = nextReal?.gap ?? '';
      if (nextReal) {
        if (remembered && remembered.nextGap !== null) nextGap = remembered.nextGap;
        else if (freshReals.length === 0 && oldFirstReal) nextGap = oldFirstReal.gap;
        else if (!oldFirstReal && !prevReal && freshReals.length > 0) nextGap = fallbackGap;
        if (attempt.widen && (prevReal || freshReals.length > 0)) nextGap = separator(nextGap);
      }

      const nonBlank =
        freshReals.some((segment, k) => (k > 0 || prevReal) && !hasBlankLine(segment.gap)) ||
        (nextReal !== null &&
          (prevReal !== null || freshReals.length > 0) &&
          !hasBlankLine(nextGap));

      // The written blocks with the ones around them: do they read back as the editor shows them?
      let verified = true;
      const parts: Segment[] = [];
      if (prevReal) parts.push(prevReal);
      parts.push(...freshReals);
      if (nextReal) parts.push({ ...(nextFlipped ?? nextReal), gap: nextGap });
      if (!patched?.inert && parts.length >= 2) {
        let size = 0;
        for (const part of parts) size += part.src.length + part.gap.length;
        if (size > CONTEXT_LIMIT) {
          // Too much to read again on every edit: a blank line between the blocks is trusted.
          verified = !nonBlank;
        } else {
          let text = '';
          parts.forEach((part, k) => {
            text += (k === 0 && prevReal ? '' : part.gap) + part.src;
          });
          const parsed = parseDocument(text, { trailingParagraph: false }).segments;
          verified =
            parsed.length === parts.length &&
            parsed.every(
              (segment, k) => fingerprintOf(segment.node) === fingerprintOf(parts[k]!.node),
            );
        }
      }
      return {
        fresh,
        freshReals,
        patched,
        remembered,
        nextFlipped,
        nextGap,
        maxLevel,
        usedExact,
        nonBlank,
        verified,
      };
    };

    // Write, verify in context, and when that fails try harder: blocks kept apart by a blank line,
    // then written by the serializer instead of from memory or by patching, then stronger escapes.
    let attempt: Attempt = { from: 0, exact: true, widen: false };
    let built: Built | null = null;
    for (let tries = 0; tries < 12; tries += 1) {
      built = build(attempt);
      if (!built) return { ok: false };
      if (built.verified) break;
      if (!attempt.widen && built.nonBlank) attempt = { ...attempt, widen: true };
      else if (built.usedExact) attempt = { ...attempt, exact: false };
      else if (built.maxLevel >= 0 && built.maxLevel < LEVELS.length - 1) {
        attempt = { ...attempt, from: built.maxLevel + 1 };
      } else {
        return { ok: false };
      }
      built = null;
    }
    if (!built) return { ok: false };
    const { fresh, freshReals, patched, remembered, nextFlipped, nextGap } = built;

    // The source region that changes: from the end of the real block before the window to the start
    // of the real block after it (gaps included), or to the window's last block when nothing follows.
    let nextSegments: Segment[];
    let nextText: string;
    let changes: TextChange[];
    const regionStart = prev >= 0 ? this.srcEnd[prev]! : 0;
    const patchOnly =
      !!patched &&
      !!oldFirstReal &&
      freshReals.length === 1 &&
      freshReals[0] === patched.segment &&
      freshReals[0]!.gap === oldFirstReal.gap &&
      !nextFlipped &&
      (!nextReal || nextGap === nextReal.gap);
    if (patched && oldFirstReal && patchOnly) {
      // The patch knows exactly what it changed.
      const at = this.srcStart[i]!;
      nextSegments = [...old.slice(0, i), ...fresh, ...old.slice(oldEnd)];
      const c = patched.change;
      nextText =
        this.text.slice(0, at + c.from) +
        patched.segment.src.slice(c.from, c.from + c.insertedLength) +
        this.text.slice(at + c.to);
      changes =
        c.to === c.from && c.insertedLength === 0
          ? []
          : [{ from: at + c.from, to: at + c.to, insertedLength: c.insertedLength }];
    } else {
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
      nextSegments = [...old.slice(0, i), ...fresh, ...old.slice(oldEnd)];
      if (nextReal && (nextFlipped || nextGap !== nextReal.gap)) {
        const at = nextSegments.indexOf(nextReal);
        nextSegments[at] = { ...(nextFlipped ?? nextReal), gap: nextGap };
      }
      nextText = this.text.slice(0, regionStart) + newRegion + this.text.slice(regionEnd);
      changes = diffHunks(oldRegion, newRegion).map((hunk) => ({
        from: regionStart + hunk.from,
        to: regionStart + hunk.to,
        insertedLength: hunk.insertedLength,
      }));
    }

    // (The first version of a block before a run of typed characters is kept apart from the cap: a
    // run is undone as one, and that version is what it comes back to.)
    const continuesRun = !!patched && oldFirstReal?.node === this.lastPatched;
    this.lastPatched = patched ? patched.segment.node : null;
    oldReals.forEach((segment, k) => {
      if (segment.node.type.name === 'atom_block') return;
      this.recent.unshift({
        pinned: !continuesRun,
        node: segment.node,
        src: segment.src,
        tbs: segment.tbs,
        after: freshReals[k]?.node ?? null,
        bytes: segment.src.length,
        by: history || 'edit',
      });
      this.recentBytes += segment.src.length;
    });
    // Remember both sides of a change in the number of blocks, with the whitespace around them.
    const gapsChanged =
      freshReals.some(
        (segment, k) => oldReals[k] !== undefined && segment.gap !== oldReals[k]!.gap,
      ) ||
      (nextReal !== null && nextGap !== nextReal.gap);
    if (oldReals.length !== freshReals.length || nextFlipped || gapsChanged) {
      const context = { prev: prevReal?.node ?? null, next: nextReal?.node ?? null };
      const sizeOf = (list: readonly Segment[]) =>
        list.reduce((sum, segment) => sum + segment.src.length, 0);
      const there = {
        ...context,
        segments: oldReals,
        nextGap: nextReal?.gap ?? null,
        nextSegment: nextReal,
        other: freshReals.map((segment) => segment.node),
        bytes: sizeOf(oldReals),
        by: (history || 'edit') as Origin,
      };
      const here = {
        ...context,
        segments: freshReals,
        nextGap: nextReal ? nextGap : null,
        nextSegment: nextFlipped ?? nextReal,
        other: oldReals.map((segment) => segment.node),
        bytes: sizeOf(freshReals),
        by: (history || 'edit') as Origin,
      };
      this.windows.unshift(there, here);
      this.windowBytes += there.bytes + here.bytes;
      this.pruneWindows();
    }
    this.pruneRecent();
    void remembered;
    this.segments = nextSegments;
    this.text = nextText;
    this.recompute();
    if ([...oldReals, ...freshReals].some((s) => s.node.type.name === 'atom_block')) {
      this.style = { ...this.style, labels: labelsOf(nextSegments) };
    }
    return { ok: true, text: nextText, changes };
  }

  /** Thins the memory for exact undo: bounded by count and size, the middle of a run of typing first. */
  private pruneRecent() {
    if (this.recent.length <= 512 && this.recentBytes <= RECENT_BYTES / 2) return;
    const kept: RecentEntry[] = [];
    let bytes = 0;
    let loose = 0;
    let looseBytes = 0;
    for (const entry of this.recent) {
      if (!entry.pinned) {
        if (loose >= RECENT_LOOSE_ENTRIES || looseBytes + entry.bytes > RECENT_LOOSE_BYTES)
          continue;
        loose += 1;
        looseBytes += entry.bytes;
      }
      if (kept.length >= RECENT_ENTRIES || bytes + entry.bytes > RECENT_BYTES) continue;
      kept.push(entry);
      bytes += entry.bytes;
    }
    this.recent = kept;
    this.recentBytes = bytes;
  }

  private pruneWindows() {
    if (this.windows.length <= WINDOW_ENTRIES && this.windowBytes <= WINDOW_BYTES) return;
    const kept: WindowMemory[] = [];
    let bytes = 0;
    for (const entry of this.windows) {
      if (kept.length >= WINDOW_ENTRIES || bytes + entry.bytes > WINDOW_BYTES) break;
      kept.push(entry);
      bytes += entry.bytes;
    }
    this.windows = kept;
    this.windowBytes = bytes;
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
