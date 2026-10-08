import type { Mark, Node as PMNode } from 'prosemirror-model';

import { findCitations } from '@/features/editor/lib/remark-plugins';

import type { InlineMap, InlineToken } from './inline-map';
import { marksKey, parseDocument, type TextblockInfo } from './parse';
import { sameMeaning } from './equivalence';
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

/** The document's conventions where Markdown leaves a choice, so edited blocks do not change style. */
export interface SerializeStyle {
  emphasis: '*' | '_';
  strong: '**' | '__';
  hardBreak: '\\' | '  ';
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
}

const LINE_START_TRIGGER =
  /^( {0,3})(#{1,6}(?=[ \t]|$)|>|[-+*](?=[ \t]|$)|(\d{1,9})([.)])(?=[ \t]|$)|`{3,}|~{3,})/;
const LINE_START_WIDE = /^( {0,3})([#>\-+*=_~`]|\d{1,9}[.)])/;

/** Text for the source: the characters of `text` with the escapes the level asks for. */
export function escapeText(text: string, ctx: EscapeContext): Escaped {
  const { level } = ctx;
  let dropFrom = text.length;
  if (ctx.trimEnd) {
    while (dropFrom > 0 && (text[dropFrom - 1] === ' ' || text[dropFrom - 1] === '\t'))
      dropFrom -= 1;
  }
  // Indices that get a backslash before them.
  const escapeAt = new Set<number>();

  if (ctx.lineStart) {
    const trigger = (level >= 1 ? LINE_START_WIDE : LINE_START_TRIGGER).exec(text);
    if (trigger) {
      const lead = trigger[1]!.length;
      // For a list number the dot or bracket is escaped, otherwise the first character.
      const numbered = /^(\d{1,9})([.)])/.exec(trigger[2]!);
      escapeAt.add(lead + (numbered ? numbered[1]!.length : 0));
    }
    if (ctx.lineEnd && /^ {0,3}#{1,6}[ \t]*$/.test(text)) escapeAt.add(text.indexOf('#'));
  }

  for (let i = 0; i < text.length; i += 1) {
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
      case '<':
        if (level >= 2 || (next !== undefined && /[a-zA-Z/!?]/.test(next))) escapeAt.add(i);
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
      case '$':
        if (level >= 2) escapeAt.add(i);
        break;
      default:
        break;
    }
  }

  if (escapeAt.size === 0 && dropFrom === text.length) return { str: text };
  let str = '';
  const starts = new Int32Array(text.length);
  const ends = new Int32Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    if (i >= dropFrom) {
      starts[i] = str.length;
      ends[i] = str.length;
      continue;
    }
    if (escapeAt.has(i)) str += '\\';
    starts[i] = str.length;
    str += text[i];
    ends[i] = str.length;
  }
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
    const lead = /^[ \t]*/.exec(text)![0].length;
    const trail = text.length === lead ? 0 : /[ \t]*$/.exec(text)![0].length;
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

function writeInline(
  textblock: PMNode,
  pmStart: number,
  w: Writer,
  style: SerializeStyle,
  level: EscapeLevel,
): InlineResult {
  const origin = w.pos;
  const runs = hoistWhitespace(buildRuns(textblock, pmStart));
  const tokens: InlineToken[] = [];
  const open: Mark[] = [];
  let lineStart = true;

  const closeTo = (keep: number) => {
    while (open.length > keep) {
      const mark = open.pop()!;
      w.write(closeDelimiter(mark, style));
    }
  };

  runs.forEach((run, index) => {
    if (run.kind === 'soft' || run.kind === 'hard') {
      closeTo(0);
      // A hard break with nothing after it would be a literal backslash.
      const rest = runs.slice(index + 1);
      if (run.kind === 'hard' && !rest.some((r) => r.kind === 'text' || r.kind === 'atom')) {
        tokens.push({
          pm: run.pm - pmStart,
          len: 1,
          s: w.pos - origin,
          e: w.pos - origin,
          kind: 'break',
          marks: '',
        });
        return;
      }
      const s = w.pos - origin;
      if (run.kind === 'hard') w.write(style.hardBreak);
      const at = w.pos - origin;
      w.newline();
      tokens.push({
        pm: run.pm - pmStart,
        len: 1,
        s: run.kind === 'hard' ? s : at,
        e: at + 1,
        kind: 'break',
        marks: '',
      });
      lineStart = true;
      return;
    }

    // Marks: keep the common prefix of the open stack, close the rest, open the new ones.
    const want = [...run.marks].sort(
      (a, b) =>
        MARK_ORDER.indexOf(a.type.name as (typeof MARK_ORDER)[number]) -
        MARK_ORDER.indexOf(b.type.name as (typeof MARK_ORDER)[number]),
    );
    const codeMark = want.find((mark) => mark.type.name === 'code');
    const nonCode = want.filter((mark) => mark.type.name !== 'code');
    let common = 0;
    while (common < open.length && common < nonCode.length && open[common]!.eq(nonCode[common]!)) {
      common += 1;
    }
    closeTo(common);
    for (let i = common; i < nonCode.length; i += 1) {
      const mark = nonCode[i]!;
      w.write(openDelimiter(mark, style));
      open.push(mark);
      lineStart = false;
    }

    const key = marksKey(run.marks);
    const inLink = open.some((mark) => mark.type.name === 'link');
    if (run.kind === 'atom') {
      const s = w.pos - origin;
      w.raw(run.source);
      tokens.push({ pm: run.pm - pmStart, len: 1, s, e: w.pos - origin, kind: 'atom', marks: key });
      lineStart = false;
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
      return;
    }
    const next = runs[index + 1];
    const lineEnd = !next || next.kind === 'soft' || next.kind === 'hard';
    const escaped = escapeText(run.text, {
      level,
      lineStart,
      lineEnd,
      inLink,
      trimEnd: next?.kind === 'soft',
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
    if (escaped.str.trim() !== '') lineStart = false;
  });
  closeTo(0);
  return { map: tokens };
}

const isList = (node: PMNode) =>
  node.type.name === 'bullet_list' || node.type.name === 'ordered_list';

interface BlockContext {
  style: SerializeStyle;
  level: EscapeLevel;
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
      if (node.content.size === 0) w.trimEndSpaces();
      ctx.tbs.push({ pm: pmPos + 1, size: node.content.size, s: origin, e: w.pos, map });
      return;
    }
    case 'heading': {
      const level = node.attrs['level'] as number;
      const setext = node.attrs['setext'] === true && level <= 2 && node.content.size > 0;
      if (!setext) w.write(`${'#'.repeat(level)}${node.content.size > 0 ? ' ' : ''}`);
      const origin = w.pos;
      const { map } = writeInline(node, pmPos + 1, w, ctx.style, ctx.level);
      const end = w.pos;
      if (setext) {
        w.newline();
        w.write((level === 1 ? '=' : '-').repeat(Math.max(3, Math.min(end - origin, 20))));
      }
      ctx.tbs.push({ pm: pmPos + 1, size: node.content.size, s: origin, e: end, map });
      return;
    }
    case 'code_block': {
      const text = node.textContent;
      const origin = w.pos;
      const starts: number[] = [];
      const ends: number[] = [];
      if (node.attrs['fence'] === 'indent' && canIndent(text)) {
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
    if (child.type.name === 'paragraph' && child.content.size === 0 && parent.childCount > 1) {
      ctx.tbs.push({ pm: pos + 1, size: 0, s: w.pos, e: w.pos, map: [] });
      return;
    }
    if (written) {
      if (tight && isList(child)) w.newline();
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
 * Source for one top-level block at an escape level. Textblock offsets in the result are relative
 * to the block's source start; `pm` offsets are relative to the block node's start.
 */
export function serializeBlock(
  node: PMNode,
  style: SerializeStyle,
  level: EscapeLevel,
): SerializedBlock {
  const w = new Writer();
  const ctx: BlockContext = { style, level, tbs: [] };
  writeBlock(node, 0, w, ctx);
  return { src: w.out, tbs: ctx.tbs };
}

/** Whether `source` parses to exactly one block that means `node`. */
export function reads(source: string, node: PMNode): boolean {
  if (source.trim() === '') return false;
  const parsed = parseDocument(source, { trailingParagraph: false });
  if (parsed.segments.length !== 1) return false;
  return sameMeaning([node], [parsed.segments[0]!.node]);
}

/** The first escape level whose output reads back as the block, or `null` (the edit is refused). */
export function serializeVerified(
  node: PMNode,
  style: SerializeStyle,
): (SerializedBlock & { level: EscapeLevel }) | null {
  if (node.type.name === 'atom_block') {
    return { src: node.attrs['source'] as string, tbs: [], level: 0 };
  }
  for (const level of [0, 1, 2] as const) {
    let result: SerializedBlock;
    try {
      result = serializeBlock(node, style, level);
    } catch {
      return null;
    }
    if (reads(result.src, node)) return { ...result, level };
  }
  return null;
}
