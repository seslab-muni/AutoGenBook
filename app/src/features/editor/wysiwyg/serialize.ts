import type { Mark, Node as PMNode } from 'prosemirror-model';

import { findCitations } from '@/features/editor/lib/remark-plugins';

import type { InlineMap, InlineToken } from './inline-map';
import { marksKey, parseDocument, type TextblockInfo } from './parse';
import { isBlankParagraph, sameMeaning } from './equivalence';
import { MARK_ORDER } from './schema';

/**
 * Editor block -> Markdown source, for the blocks the user has edited (issue #182, phase 5).
 * Blocks nobody touched never go through here: they keep their original source slice.
 *
 * The output is *verified*: `serializeVerified` parses what it wrote with the same pipeline the
 * read-only view uses and only accepts it when it means what the edited block means (see
 * `equivalence.ts`). Text is escaped as little as possible, and only as far as needed: level 0
 * escapes what cannot stay as typed (a `\` before punctuation, an entity, a line that would turn
 * into a heading or list), level 1 the inline syntax characters, level 2 all punctuation that has a
 * meaning. A block that reads back differently at every level is refused (the edit is not applied)
 * rather than saved as something else.
 *
 * Alongside the text the serializer produces the position maps of the textblocks it wrote, so the
 * caret, selection and highlights keep mapping to the new source without parsing it again.
 */

export type EscapeLevel = 0 | 1 | 2;

/**
 * How hard the serializer tries, in order: escapes at the least level, then the same with
 * punctuation at the edge of emphasised text moved out of the emphasis (`**「重要」**です` cannot be
 * written, `「**重要**」です` can), then more escapes, then both.
 */
export interface SerializeLevel {
  escape: EscapeLevel;
  /** Punctuation at the edge of emphasised text is written outside the emphasis. */
  punct: boolean;
  /** Indented code is written fenced (two indented blocks with a blank line between are one block). */
  fence: boolean;
}
export const LEVELS: readonly SerializeLevel[] = [
  { escape: 0, punct: false, fence: false },
  { escape: 0, punct: true, fence: true },
  { escape: 1, punct: false, fence: true },
  { escape: 1, punct: true, fence: true },
  { escape: 2, punct: true, fence: true },
];

/** The document's conventions where Markdown leaves a choice, so edited blocks do not change style. */
export interface SerializeStyle {
  emphasis: '*' | '_';
  strong: '**' | '__';
  hardBreak: '\\' | '  ';
  /** Labels of the link definitions and footnotes in the draft (normalised): literal `[label]` must not become a reference. */
  labels?: ReadonlySet<string>;
}

export const DEFAULT_STYLE: SerializeStyle = { emphasis: '*', strong: '**', hardBreak: '\\' };

/** Looks at the source for the choices it makes (emphasis and strong delimiters, hard break form). */
export function detectStyle(source: string): SerializeStyle {
  const count = (pattern: RegExp) => (source.match(pattern) ?? []).length;
  const star = count(/(?<![*\w\\])\*[^*\s](?:[^*\n]*[^*\s])?\*(?![*\w])/g);
  const under = count(/(?<![_\w\\])_[^_\s](?:[^_\n]*[^_\s])?_(?![_\w])/g);
  const bold = count(/\*\*[^*\s](?:[^*\n]*[^*\s])?\*\*/g);
  const boldUnder = count(/__[^_\s](?:[^_\n]*[^_\s])?__/g);
  const slash = count(/\\\n/g);
  const spaces = count(/\S {2,}\n\S/g);
  return {
    emphasis: under > star ? '_' : '*',
    strong: boldUnder > bold ? '__' : '**',
    hardBreak: spaces > slash ? '  ' : '\\',
  };
}

const PUNCT = /[!-/:-@[-`{-~]/;
const isAlnum = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

interface Escaped {
  str: string;
  /** Output offset of each input character's own text (after any backslash), and where it ends. */
  starts?: Int32Array;
  ends?: Int32Array;
}

interface EscapeContext {
  level: EscapeLevel;
  /** The chunk begins a source line (nothing but whitespace before it on the line). */
  lineStart: boolean;
  /** The chunk is followed by a line end or the end of the textblock. */
  lineEnd: boolean;
  inLink: boolean;
  /** Spaces at the end of the chunk are dropped (a line break follows). */
  trimEnd: boolean;
  /** Spaces at the start of the chunk are dropped (it begins a line: leading spaces mean nothing, and can mean code). */
  trimStart?: boolean;
  /**
   * The chunk is a piece typed into a block, not the whole text: `$` is then left to the verification
   * (a pair of them may be formed with a `$` that is already there) until a stronger level.
   */
  local?: boolean;
  /** The chunk is followed by something that would continue an automatic link (emphasis, an atom): a link at its end is broken. */
  urlEnd?: boolean;
  /** The character that follows the chunk in the source (a chunk typed into a block), for `<` at its end. */
  following?: string | undefined;
  /** See `SerializeStyle.labels`. */
  labels?: ReadonlySet<string> | undefined;
}

const LINE_START_TRIGGER =
  /^( {0,3})(#{1,6}(?=[ \t]|$)|>|[-+*](?=[ \t]|$)|(\d{1,9})([.)])(?=[ \t]|$)|`{3,}|~{3,})/;
const LINE_START_WIDE = /^( {0,3})([#>\-+*=_~`$]|\d{1,9}[.)])/;

/**
 * The `$` signs of `text` that would be read as the delimiters of a formula that is not one by the
 * rule the editor writes formulas by (a pair of equal runs on one line with something other than
 * whitespace inside its edges, see `isCleanMath`): those get a backslash, a clean pair stays as typed.
 */
function strayDollars(text: string): Set<number> {
  const out = new Set<number>();
  const runs: { at: number; len: number }[] = [];
  const re = /\$+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) runs.push({ at: m.index, len: m[0].length });
  const used = new Set<number>();
  for (let i = 0; i < runs.length; i += 1) {
    if (used.has(i)) continue;
    const open = runs[i]!;
    for (let j = i + 1; j < runs.length; j += 1) {
      const close = runs[j]!;
      if (close.len !== open.len || used.has(j)) continue;
      used.add(j);
      const inner = text.slice(open.at + open.len, close.at);
      if (inner === '' || /^\s|\s$/.test(inner)) {
        for (let k = 0; k < open.len; k += 1) {
          out.add(open.at + k);
          out.add(close.at + k);
        }
      }
      break;
    }
  }
  return out;
}

/** Text for the source: the characters of `text` with the escapes the level asks for. */
export function escapeText(text: string, ctx: EscapeContext): Escaped {
  const { level } = ctx;
  let dropFrom = text.length;
  if (ctx.trimEnd) {
    while (dropFrom > 0 && (text[dropFrom - 1] === ' ' || text[dropFrom - 1] === '\t'))
      dropFrom -= 1;
  }
  let dropTo = 0;
  if (ctx.trimStart) {
    while (dropTo < dropFrom && (text[dropTo] === ' ' || text[dropTo] === '\t')) dropTo += 1;
  }
  // Indices that get a backslash before them.
  const escapeAt = new Set<number>();

  if (ctx.lineStart) {
    const body = text.slice(dropTo);
    const trigger = (level >= 1 ? LINE_START_WIDE : LINE_START_TRIGGER).exec(body);
    if (trigger) {
      const lead = trigger[1]!.length;
      // For a list number the dot or bracket is escaped, otherwise the first character.
      const numbered = /^(\d{1,9})([.)])/.exec(trigger[2]!);
      escapeAt.add(dropTo + lead + (numbered ? numbered[1]!.length : 0));
    }
    if (ctx.lineEnd && /^ {0,3}#{1,6}[ \t]*$/.test(body)) escapeAt.add(dropTo + body.indexOf('#'));
  }

  if (ctx.labels && ctx.labels.size > 0 && text.includes('[')) {
    const re = /\[([^[\]]*)\]/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const key = m[1]!.trim().toLowerCase().replace(/\s+/g, ' ');
      if (ctx.labels.has(key)) escapeAt.add(m.index);
    }
  }
  // An address typed right before emphasis or an atom would swallow it (`http://x.y**b**` is one
  // link): it is written between angle brackets, where it ends where it should.
  let wrapFrom = -1;
  if (ctx.urlEnd) {
    const head = text.slice(0, dropFrom);
    const m = /(?:^|[^\p{L}\p{N}])((?:https?|ftp):\/\/[^\s<>\\]+)$/iu.exec(head);
    if (m) wrapFrom = m.index + m[0].length - m[1]!.length;
    else {
      const www = /(?:^|[^\p{L}\p{N}])(www\.[^\s]*)$/iu.exec(head);
      if (www) escapeAt.add(www.index + www[0].length - www[1]!.length + 3);
    }
  }
  const dollars = level === 0 && !ctx.local && text.includes('$') ? strayDollars(text) : null;
  for (let i = dropTo; i < text.length; i += 1) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === '\\') {
      if (next === undefined || PUNCT.test(next) || next === '\n') escapeAt.add(i);
      continue;
    }
    if (c === '&') {
      if (level >= 2 || /^&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(text.slice(i, i + 12))) {
        escapeAt.add(i);
      }
      continue;
    }
    if (c === '<') {
      // Inline HTML, an autolink: text that must stay text, at every level.
      const after = next ?? ctx.following;
      if (level >= 2 || (after !== undefined && /[a-zA-Z/!?]/.test(after))) escapeAt.add(i);
      continue;
    }
    if (c === '$') {
      if (level >= 1 || (dollars && dollars.has(i))) escapeAt.add(i);
      continue;
    }
    if (ctx.inLink && (c === '[' || c === ']')) {
      escapeAt.add(i);
      continue;
    }
    if (level === 0) continue;
    switch (c) {
      case '*':
      case '`':
      case '~':
      case '|':
        escapeAt.add(i);
        break;
      case '_':
        if (level >= 2 || !isAlnum(text[i - 1]) || !isAlnum(next)) escapeAt.add(i);
        break;
      case '[':
        // `[@key]` is a citation, which stays one: it is parsed into an atom the next time the block is read.
        if (level >= 2 || findCitations(text.slice(i)).every((cite) => cite.index !== 0)) {
          escapeAt.add(i);
        }
        break;
      case ']':
      case '!':
      case '>':
      case '#':
      case '+':
      case '-':
      case '=':
      case '{':
      case '}':
        if (level >= 2) escapeAt.add(i);
        break;
      default:
        break;
    }
  }

  if (wrapFrom >= 0) {
    // (Nothing inside the brackets is escaped: backslashes do not work there.)
    for (const at of [...escapeAt]) if (at >= wrapFrom) escapeAt.delete(at);
  }
  if (escapeAt.size === 0 && dropFrom === text.length && dropTo === 0 && wrapFrom < 0) {
    return { str: text };
  }
  let str = '';
  const starts = new Int32Array(text.length);
  const ends = new Int32Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    if (i < dropTo || i >= dropFrom) {
      starts[i] = str.length;
      ends[i] = str.length;
      continue;
    }
    if (i === wrapFrom) str += '<';
    if (escapeAt.has(i)) str += '\\';
    starts[i] = str.length;
    str += text[i];
    ends[i] = str.length;
  }
  if (wrapFrom >= 0) str += '>';
  return { str, starts, ends };
}

class Writer {
  out = '';
  /** Prefix of the current container's continuation lines (`> `, indentation). */
  prefix = '';

  get pos() {
    return this.out.length;
  }
  write(text: string) {
    this.out += text;
  }
  /** Ends the line and starts the next one inside the current container (an empty line keeps no trailing spaces). */
  newline(empty = false) {
    this.out += `\n${empty ? this.prefix.replace(/ +$/, '') : this.prefix}`;
  }
  /** Ends the line, leaves one blank line (its prefix without trailing spaces), starts the next. */
  blankLine() {
    this.out += `\n${this.prefix.replace(/ +$/, '')}\n${this.prefix}`;
  }
  /** Text that may contain line breaks; every continuation line gets the container prefix. */
  raw(text: string) {
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (index > 0) this.out += `\n${line === '' ? this.prefix.replace(/ +$/, '') : this.prefix}`;
      this.out += line;
    });
  }
  trimEndSpaces() {
    this.out = this.out.replace(/ +$/, '');
  }
}

interface Run {
  kind: 'text' | 'atom' | 'soft' | 'hard';
  text: string;
  source: string;
  marks: readonly Mark[];
  pm: number;
  len: number;
}

/** Marks in `a` that `b` also has. */
function intersect(a: readonly Mark[], b: readonly Mark[]): Mark[] {
  return a.filter((mark) => b.some((other) => other.eq(mark)));
}

/**
 * The textblock's content as runs for output: text split at line breaks (a newline inside a text
 * node is a soft break), with atoms and breaks as runs of their own. `pm` is the editor offset.
 */
function buildRuns(textblock: PMNode, pmStart: number): Run[] {
  const out: Run[] = [];
  let pm = pmStart;
  textblock.forEach((child) => {
    if (child.isText) {
      const text = child.text!;
      let at = 0;
      for (let i = 0; i <= text.length; i += 1) {
        if (i < text.length && text[i] !== '\n') continue;
        if (i > at) {
          out.push({
            kind: 'text',
            text: text.slice(at, i),
            source: '',
            marks: child.marks,
            pm: pm + at,
            len: i - at,
          });
        }
        if (i < text.length) {
          out.push({ kind: 'soft', text: '', source: '', marks: [], pm: pm + i, len: 1 });
        }
        at = i + 1;
      }
      pm += text.length;
      return;
    }
    const type = child.type.name;
    if (type === 'atom_inline') {
      out.push({
        kind: 'atom',
        text: '',
        source: child.attrs['source'] as string,
        marks: child.marks,
        pm,
        len: 1,
      });
    } else if (type === 'soft_break') {
      out.push({ kind: 'soft', text: '', source: '', marks: [], pm, len: 1 });
    } else if (type === 'hard_break') {
      out.push({ kind: 'hard', text: '', source: '', marks: [], pm, len: 1 });
    }
    pm += child.nodeSize;
  });
  return out;
}

const hasCode = (marks: readonly Mark[]) => marks.some((mark) => mark.type.name === 'code');

/**
 * Moves edge whitespace of marked text runs out of the marks: Markdown does not open or close
 * emphasis next to a space.
 */
function hoistWhitespace(runs: readonly Run[]): Run[] {
  const out: Run[] = [];
  runs.forEach((run, index) => {
    if (run.kind !== 'text' || run.marks.length === 0 || hasCode(run.marks)) {
      out.push(run);
      return;
    }
    const prev = runs[index - 1];
    const next = runs[index + 1];
    const text = run.text;
    const lead = /^[\p{Zs}\t]*/u.exec(text)![0].length;
    const trail = text.length === lead ? 0 : /[\p{Zs}\t]*$/u.exec(text)![0].length;
    const side = (neighbour: Run | undefined) =>
      neighbour && neighbour.kind !== 'soft' && neighbour.kind !== 'hard' ? neighbour.marks : [];
    const toRun = (from: number, to: number, marks: readonly Mark[]): Run => ({
      ...run,
      text: text.slice(from, to),
      marks,
      pm: run.pm + from,
      len: to - from,
    });
    if (lead === text.length) {
      // Whitespace only: it takes what both neighbours have in common.
      out.push(toRun(0, text.length, intersect(intersect(run.marks, side(prev)), side(next))));
      return;
    }
    if (lead > 0) out.push(toRun(0, lead, intersect(run.marks, side(prev))));
    out.push(toRun(lead, text.length - trail, run.marks));
    if (trail > 0)
      out.push(toRun(text.length - trail, text.length, intersect(run.marks, side(next))));
  });
  return out;
}

const EMPHASIS = new Set(['strong', 'em', 'strike']);
const PUNCT_LEAD = /^[\p{Zs}\t\p{P}\p{S}]+/u;
const PUNCT_TRAIL = /[\p{Zs}\t\p{P}\p{S}]+$/u;

/**
 * Moves punctuation at the edge of emphasised text out of the emphasis: Markdown opens emphasis
 * before punctuation only after a space or punctuation and closes it after punctuation only
 * before one, so `**「重要」**です` is not strong text but `「**重要**」です` is.
 */
function hoistPunctuation(runs: readonly Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (
      run.kind !== 'text' ||
      hasCode(run.marks) ||
      !run.marks.some((m) => EMPHASIS.has(m.type.name))
    ) {
      out.push(run);
      continue;
    }
    const outer = run.marks.filter((mark) => !EMPHASIS.has(mark.type.name));
    const lead = PUNCT_LEAD.exec(run.text)?.[0].length ?? 0;
    const rest = run.text.slice(lead);
    const trail = rest ? (PUNCT_TRAIL.exec(rest)?.[0].length ?? 0) : 0;
    if (lead === 0 && trail === 0) {
      out.push(run);
      continue;
    }
    // (UTF-16 lengths of the matched punctuation; `lead`/`trail` above are in code units.)
    const toRun = (from: number, to: number, marks: readonly Mark[]): Run => ({
      ...run,
      text: run.text.slice(from, to),
      marks,
      pm: run.pm + from,
      len: to - from,
    });
    const coreEnd = run.text.length - trail;
    if (lead > 0) out.push(toRun(0, lead, outer));
    if (coreEnd > lead) out.push(toRun(lead, coreEnd, run.marks));
    if (trail > 0) out.push(toRun(coreEnd, run.text.length, outer));
  }
  return out;
}

function linkDestination(href: string): string {
  if (href === '') return '<>';
  if (/[\s<>()]/.test(href) || /^\s|\s$/.test(href)) {
    return `<${href.replace(/[\\<>]/g, (c) => `\\${c}`)}>`;
  }
  return href.replace(/\\/g, '\\\\');
}

function linkTitle(title: string): string {
  return title ? ` "${title.replace(/["\\]/g, (c) => `\\${c}`)}"` : '';
}

function openDelimiter(mark: Mark, style: SerializeStyle): string {
  switch (mark.type.name) {
    case 'strong':
      return style.strong;
    case 'em':
      return style.emphasis;
    case 'strike':
      return '~~';
    case 'link':
      return '[';
    default:
      return '';
  }
}

function closeDelimiter(mark: Mark, style: SerializeStyle): string {
  switch (mark.type.name) {
    case 'link':
      return `](${linkDestination(mark.attrs['href'] as string)}${linkTitle(mark.attrs['title'] as string)})`;
    default:
      return openDelimiter(mark, style);
  }
}

function codeSpan(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  // Shortest backtick run that does not occur in the content.
  let fence = '`';
  const lengths = new Set(runs.map((run) => run.length));
  while (lengths.has(fence.length)) fence += '`';
  void longest;
  const pad =
    text.startsWith('`') ||
    text.endsWith('`') ||
    (text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '');
  return pad ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

interface InlineResult {
  map: InlineMap;
}

const WORD = /[\p{L}\p{N}]/u;

/** A bare address written right before something that would continue it: ended where it ends. */
function protectLink(source: string): string {
  if (/^(?:https?|ftp):\/\/[^\s<>\\]+$/i.test(source)) return `<${source}>`;
  if (/^www\.[^\s\\]*$/i.test(source)) return `www\\.${source.slice(4)}`;
  return source;
}

/**
 * The delimiter that opens (and closes) `mark` at run `index`: the document's style, except where
 * that cannot work - an `_` or `__` that touches a letter or digit on either side is not emphasis.
 */
function delimiterFor(
  mark: Mark,
  style: SerializeStyle,
  runs: readonly Run[],
  index: number,
  before: string,
): string {
  const base = openDelimiter(mark, style);
  if (base !== '_' && base !== '__') return base;
  let end = index;
  while (end < runs.length && runs[end]!.marks.some((m) => m.eq(mark))) end += 1;
  const after = runs[end];
  const nextChar = after && after.kind === 'text' ? after.text[0] : undefined;
  if ((before && WORD.test(before)) || (nextChar && WORD.test(nextChar))) {
    return base === '_' ? '*' : '**';
  }
  return base;
}

function writeInline(
  textblock: PMNode,
  pmStart: number,
  w: Writer,
  style: SerializeStyle,
  level: SerializeLevel,
): InlineResult {
  const origin = w.pos;
  let runs = hoistWhitespace(buildRuns(textblock, pmStart));
  if (level.punct) runs = hoistPunctuation(runs);
  const heading = textblock.type.name === 'heading';
  /** Whether what follows a run could be taken for the rest of an automatic link written right before it. */
  const continues = (next: Run | undefined) =>
    !!next &&
    (next.kind === 'atom' ||
      (next.kind === 'text' && /\S/.test(next.text[0] ?? ' ')) ||
      (next.kind === 'hard' && style.hardBreak === '\\'));
  const tokens: InlineToken[] = [];
  const open: { mark: Mark; close: string }[] = [];
  /** Nothing that matters is on this line yet (the escapes for a line's start apply). */
  let lineStart = true;
  /** Something other than dropped whitespace is on this line. */
  let content = false;

  const closeTo = (keep: number) => {
    while (open.length > keep) w.write(open.pop()!.close);
  };

  runs.forEach((run, index) => {
    if (run.kind === 'soft' || run.kind === 'hard') {
      closeTo(0);
      const rest = runs.slice(index + 1);
      const at = w.pos - origin;
      // A break that ends nothing (before the end, or on an empty line), or any break in a heading
      // (a heading is one line): a space, or nothing.
      if (
        heading ||
        !content ||
        // (Two breaks in a row are one: the hard one is written.)
        (run.kind === 'soft' && runs[index + 1]?.kind === 'hard') ||
        (run.kind === 'hard' &&
          !rest.some((r) => r.kind === 'atom' || (r.kind === 'text' && /[^ \t]/.test(r.text))))
      ) {
        const space = heading && content && !w.out.endsWith(' ') && rest.length > 0;
        if (space) w.write(' ');
        tokens.push({
          pm: run.pm - pmStart,
          len: 1,
          s: at,
          e: w.pos - origin,
          kind: 'break',
          marks: '',
        });
        return;
      }
      if (run.kind === 'hard') w.write(style.hardBreak);
      const nl = w.pos - origin;
      w.newline();
      tokens.push({
        pm: run.pm - pmStart,
        len: 1,
        s: run.kind === 'hard' ? at : nl,
        e: nl + 1,
        kind: 'break',
        marks: '',
      });
      lineStart = true;
      content = false;
      return;
    }

    // Marks: keep the open ones this run still has, close the rest, open the new ones after them
    // (so `*one **two***` is one emphasis with a strong inside, not two emphasis spans).
    const want = run.marks
      .filter((mark) => mark.type.name !== 'code')
      .sort(
        (a, b) =>
          MARK_ORDER.indexOf(a.type.name as (typeof MARK_ORDER)[number]) -
          MARK_ORDER.indexOf(b.type.name as (typeof MARK_ORDER)[number]),
      );
    const codeMark = run.marks.find((mark) => mark.type.name === 'code');
    let keep = 0;
    while (keep < open.length && want.some((mark) => mark.eq(open[keep]!.mark))) keep += 1;
    closeTo(keep);
    const following = runs[index + 1];
    const endsLine = !following || following.kind === 'soft' || following.kind === 'hard';
    // (A run of nothing but whitespace that begins or ends a line is not written, and opens nothing.)
    const dropped =
      run.kind === 'text' &&
      !codeMark &&
      /^[ \t]*$/.test(run.text) &&
      ((!content && open.length === 0) || endsLine);
    if (!dropped) {
      for (const mark of want) {
        if (open.some((o) => o.mark.eq(mark))) continue;
        const delim = delimiterFor(mark, style, runs, index, w.out.slice(-1));
        w.write(delim);
        open.push({
          mark,
          close: mark.type.name === 'link' ? closeDelimiter(mark, style) : delim,
        });
        lineStart = false;
        content = true;
      }
    }

    const key = marksKey(run.marks);
    const inLink = open.some((o) => o.mark.type.name === 'link');
    if (run.kind === 'atom') {
      const s = w.pos - origin;
      w.raw(continues(runs[index + 1]) ? protectLink(run.source) : run.source);
      tokens.push({ pm: run.pm - pmStart, len: 1, s, e: w.pos - origin, kind: 'atom', marks: key });
      lineStart = false;
      content = true;
      return;
    }
    if (codeMark) {
      const span = codeSpan(run.text);
      const s = w.pos - origin;
      const inner = span.indexOf(run.text);
      w.write(span);
      tokens.push({
        pm: run.pm - pmStart,
        len: run.len,
        s: s + inner,
        e: s + inner + run.text.length,
        kind: 'text',
        marks: key,
      });
      lineStart = false;
      content = true;
      return;
    }
    const lineEnd = endsLine;
    const escaped = escapeText(run.text, {
      level: level.escape,
      lineStart,
      lineEnd,
      inLink,
      // Spaces that end a line mean nothing (and two of them are a break), spaces that begin one
      // can turn the line into code or a continuation: neither is written.
      trimEnd: lineEnd,
      trimStart: !content && open.length === 0,
      labels: style.labels,
      urlEnd: continues(following),
    });
    const s = w.pos - origin;
    w.write(escaped.str);
    const token: InlineToken = {
      pm: run.pm - pmStart,
      len: run.len,
      s,
      e: w.pos - origin,
      kind: 'text',
      marks: key,
    };
    if (escaped.starts && escaped.ends) {
      token.starts = escaped.starts.map((offset) => offset + s);
      token.ends = escaped.ends.map((offset) => offset + s);
      token.s = token.starts[0]!;
      token.e = token.ends[run.len - 1]!;
    }
    tokens.push(token);
    if (escaped.str.trim() !== '') {
      lineStart = false;
      content = true;
    }
  });
  closeTo(0);
  return { map: tokens };
}

const isList = (node: PMNode) =>
  node.type.name === 'bullet_list' || node.type.name === 'ordered_list';

interface BlockContext {
  style: SerializeStyle;
  level: SerializeLevel;
  tbs: TextblockInfo[];
}

/** Per-character source extents of code text written line by line (the newline characters count). */
function codeMap(text: string, starts: number[], ends: number[], origin: number): InlineMap {
  if (text.length === 0) return [];
  const verbatim = starts.every((start, i) => start === starts[0]! + i && ends[i] === start + 1);
  const token: InlineToken = {
    pm: 0,
    len: text.length,
    s: starts[0]! - origin,
    e: ends[ends.length - 1]! - origin,
    kind: 'text',
    marks: '',
  };
  if (!verbatim) {
    token.starts = Int32Array.from(starts, (v) => v - origin);
    token.ends = Int32Array.from(ends, (v) => v - origin);
  }
  return [token];
}

/** Writes code lines (each after the container prefix, optionally indented) and records character extents. */
function writeCodeLines(w: Writer, text: string, indent: string, starts: number[], ends: number[]) {
  text.split('\n').forEach((line, index) => {
    if (index > 0) {
      starts.push(w.pos);
      ends.push(w.pos + 1);
      w.newline(line === '');
    }
    if (line !== '') w.write(indent);
    for (let i = 0; i < line.length; i += 1) {
      starts.push(w.pos + i);
      ends.push(w.pos + i + 1);
    }
    w.write(line);
  });
}

function writeBlock(node: PMNode, pmPos: number, w: Writer, ctx: BlockContext): void {
  switch (node.type.name) {
    case 'paragraph': {
      const origin = w.pos;
      const { map } = writeInline(node, pmPos + 1, w, ctx.style, ctx.level);
      if (isBlankParagraph(node)) w.trimEndSpaces();
      // (Trimming can take the marker's own trailing space with it: the textblock starts where the source ends then.)
      ctx.tbs.push({
        pm: pmPos + 1,
        size: node.content.size,
        s: Math.min(origin, w.pos),
        e: w.pos,
        map,
      });
      return;
    }
    case 'heading': {
      const level = node.attrs['level'] as number;
      const setext = node.attrs['setext'] === true && level <= 2 && node.content.size > 0;
      if (!setext) w.write(`${'#'.repeat(level)}${node.content.size > 0 ? ' ' : ''}`);
      const origin = w.pos;
      const { map } = writeInline(node, pmPos + 1, w, ctx.style, ctx.level);
      const end = w.pos;
      if (!setext && end === origin && node.content.size > 0) w.trimEndSpaces();
      if (setext) {
        w.newline();
        w.write((level === 1 ? '=' : '-').repeat(Math.max(3, Math.min(end - origin, 20))));
      }
      ctx.tbs.push({
        pm: pmPos + 1,
        size: node.content.size,
        s: Math.min(origin, w.pos),
        e: Math.min(end, w.pos),
        map,
      });
      return;
    }
    case 'code_block': {
      const text = node.textContent;
      const origin = w.pos;
      const starts: number[] = [];
      const ends: number[] = [];
      if (node.attrs['fence'] === 'indent' && canIndent(text) && !ctx.level.fence) {
        writeCodeLines(w, text, '    ', starts, ends);
      } else {
        const info = node.attrs['info'] as string;
        const char = node.attrs['fence'] === '~' || info.includes('`') ? '~' : '`';
        const longest = (text.match(char === '~' ? /~+/g : /`+/g) ?? []).reduce(
          (max, run) => Math.max(max, run.length),
          0,
        );
        const fence = char.repeat(Math.max(3, longest + 1));
        w.write(fence + info);
        w.newline();
        if (text.length > 0) {
          writeCodeLines(w, text, '', starts, ends);
          w.newline();
        }
        w.write(fence);
      }
      ctx.tbs.push({
        pm: pmPos + 1,
        size: text.length,
        s: origin,
        e: w.pos,
        map: codeMap(text, starts, ends, origin),
      });
      return;
    }
    case 'blockquote': {
      w.write('> ');
      const saved = w.prefix;
      w.prefix += '> ';
      writeChildren(node, pmPos, w, ctx, false);
      w.prefix = saved;
      return;
    }
    case 'bullet_list':
    case 'ordered_list': {
      const ordered = node.type.name === 'ordered_list';
      const tight = node.attrs['tight'] === true;
      node.forEach((item, offset, index) => {
        if (index > 0) {
          if (tight) w.newline();
          else w.blankLine();
        }
        const marker = ordered
          ? `${(node.attrs['start'] as number) + index * (node.attrs['step'] as number)}${node.attrs['delim'] as string}`
          : (node.attrs['marker'] as string);
        w.write(`${marker} `);
        const saved = w.prefix;
        w.prefix += ' '.repeat(marker.length + 1);
        writeChildren(item, pmPos + 1 + offset, w, ctx, tight);
        w.prefix = saved;
      });
      return;
    }
    case 'atom_block':
      w.raw(node.attrs['source'] as string);
      return;
    default:
      throw new Error(`cannot serialize ${node.type.name}`);
  }
}

function canIndent(text: string): boolean {
  return text.length > 0 && !/^\s*\n|\n\s*$/.test(text) && text.trim() !== '';
}

/** A numbered list that does not start at 1 cannot interrupt a paragraph: it is text there. */
function numberedFrom2(list: PMNode): boolean {
  return list.type.name === 'ordered_list' && list.attrs['start'] !== 1;
}

function startsWithEmptyItem(list: PMNode): boolean {
  const item = list.firstChild;
  return !!item && item.childCount === 1 && isBlankParagraph(item.firstChild!);
}

function writeChildren(
  parent: PMNode,
  parentPos: number,
  w: Writer,
  ctx: BlockContext,
  tight: boolean,
) {
  let written = false;
  parent.forEach((child, offset) => {
    const pos = parentPos + 1 + offset;
    // An empty paragraph beside other content has no Markdown form: it takes no space in the
    // source, and the caret in it maps to where it would be (see `equivalence.ts`).
    if (isBlankParagraph(child) && parent.childCount > 1) {
      ctx.tbs.push({ pm: pos + 1, size: 0, s: w.pos, e: w.pos, map: [] });
      return;
    }
    if (written) {
      // (A list whose first item is empty under a paragraph would be that paragraph's underline.)
      if (tight && isList(child) && !startsWithEmptyItem(child) && !numberedFrom2(child))
        w.newline();
      else w.blankLine();
    }
    written = true;
    writeBlock(child, pos, w, ctx);
  });
}

export interface SerializedBlock {
  src: string;
  tbs: TextblockInfo[];
}

/**
 * Source for one top-level block at a level. Textblock offsets in the result are relative to the
 * block's source start; `pm` offsets are relative to the block node's start.
 */
export function serializeBlock(
  node: PMNode,
  style: SerializeStyle,
  level: SerializeLevel,
): SerializedBlock {
  const w = new Writer();
  const ctx: BlockContext = { style, level, tbs: [] };
  writeBlock(node, 0, w, ctx);
  return { src: w.out, tbs: ctx.tbs };
}

/** Whether `source` parses to exactly one block that means `node`. */
export function reads(source: string, node: PMNode): boolean {
  if (!/[^ \t\n]/.test(source)) return false;
  const parsed = parseDocument(source, { trailingParagraph: false });
  if (parsed.segments.length !== 1) return false;
  return sameMeaning([node], [parsed.segments[0]!.node]);
}

/**
 * The first level, from `from` on (an index into `LEVELS`), whose output reads back as the block,
 * or `null` (the edit is refused).
 */
export function serializeVerified(
  node: PMNode,
  style: SerializeStyle,
  from = 0,
): (SerializedBlock & { level: number }) | null {
  if (node.type.name === 'atom_block') {
    return { src: node.attrs['source'] as string, tbs: [], level: 0 };
  }
  for (let level = from; level < LEVELS.length; level += 1) {
    let result: SerializedBlock;
    try {
      result = serializeBlock(node, style, LEVELS[level]!);
    } catch {
      return null;
    }
    if (reads(result.src, node)) return { ...result, level };
  }
  return null;
}
