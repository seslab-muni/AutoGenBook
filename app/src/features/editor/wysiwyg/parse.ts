import type {
  Blockquote,
  Code,
  Heading,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
} from 'mdast';
import { Fragment, type Mark, type Node as PMNode } from 'prosemirror-model';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { normalizeDisplayMathMapped } from '@/features/editor/lib/normalize-display-math';
import { calloutOf, findCitations } from '@/features/editor/lib/remark-plugins';
import { alignValueToSource } from '@/features/editor/lib/source-map';

import type { InlineMap, InlineToken } from './inline-map';
import { schema, type AtomBlockKind, type AtomInlineKind } from './schema';

/**
 * Markdown source -> editor document, with the source kept beside it (issue #182, phase 5).
 *
 * The pipeline is the read-only view's own (`remark-parse` + GFM + math, over the display-math
 * normalised text), so what is an atom here is what that view renders specially. The result is a
 * list of *segments*, one per top-level block: the block's exact source, the exact whitespace
 * before it, and the position maps of its textblocks. Concatenating gaps and sources gives the
 * input back byte for byte; the editor document is only a view of that.
 *
 * Anything that cannot be edited faithfully becomes an atom carrying its source (`atom_block` /
 * `atom_inline`): tables, display math, callouts, HTML, footnotes, definitions, task lists, and any
 * list or quote that contains such a thing. A construct this file does not know is never dropped: a
 * block whose conversion fails is kept whole as a raw atom.
 */

/** Where one textblock sits in its segment, and how its inline content maps to the source. */
export interface TextblockInfo {
  /** Editor offset, relative to the segment node's start, of the textblock's content. */
  pm: number;
  /** Size of the textblock's content. */
  size: number;
  /** Source offsets of the textblock, relative to the segment's source start. */
  s: number;
  e: number;
  map: InlineMap;
}

/** One top-level block: its source, the whitespace before it, and its position maps. */
export interface Segment {
  node: PMNode;
  /** Whitespace between the previous block and this one (verbatim). */
  gap: string;
  /** The block's source (verbatim; empty for an empty paragraph, which has no source). */
  src: string;
  tbs: TextblockInfo[];
}

export interface ParsedDocument {
  segments: Segment[];
  /** Whitespace after the last block (verbatim). */
  tail: string;
  doc: PMNode;
}

class Unsupported extends Error {}

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

function parseTree(text: string): Root {
  return processor.parse(text) as Root;
}

interface Env {
  /** The text the parser saw (display math normalised). */
  text: string;
  /** Offset in `text` of the segment's source start. */
  base: number;
  infos: WeakMap<PMNode, { s: number; e: number; map: InlineMap }>;
}

const ENTITY = /^&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i;

export function marksKey(marks: readonly Mark[]): string {
  if (marks.length === 0) return '';
  return marks
    .map((mark) =>
      mark.type.name === 'link'
        ? `link:${mark.attrs['href'] as string}|${mark.attrs['title'] as string}`
        : mark.type.name,
    )
    .join(',');
}

function startOf(node: { position?: { start: { offset?: number | undefined } } | undefined }) {
  const offset = node.position?.start.offset;
  if (offset == null) throw new Unsupported('no position');
  return offset;
}
function endOf(node: { position?: { end: { offset?: number | undefined } } | undefined }) {
  const offset = node.position?.end.offset;
  if (offset == null) throw new Unsupported('no position');
  return offset;
}

/**
 * Builds a text token for `value[from, to)`; `map[i]` is the offset in `env.text` of `value[i]`.
 * Verbatim text needs no per-character arrays.
 */
function textToken(
  env: Env,
  origin: number,
  pm: number,
  value: string,
  from: number,
  to: number,
  map: Int32Array,
  marks: string,
): InlineToken {
  const len = to - from;
  let verbatim = true;
  const first = map[from]!;
  for (let i = 0; i < len; i += 1) {
    const at = map[from + i]!;
    if (at !== first + i || (env.text.charCodeAt(at) === 38 && value.charCodeAt(from + i) !== 38)) {
      verbatim = false;
      break;
    }
  }
  if (verbatim) {
    return { pm, len, s: first - origin, e: first + len - origin, kind: 'text', marks };
  }
  const starts = new Int32Array(len);
  const ends = new Int32Array(len);
  for (let i = 0; i < len; i += 1) {
    const at = map[from + i]!;
    starts[i] = at - origin;
    let end = at + 1;
    if (env.text.charCodeAt(at) === 38 && value.charCodeAt(from + i) !== 38) {
      const entity = ENTITY.exec(env.text.slice(at, at + 12));
      if (entity) end = at + entity[0].length;
    }
    ends[i] = end - origin;
  }
  return {
    pm,
    len,
    s: starts[0]!,
    e: ends[len - 1]!,
    kind: 'text',
    marks,
    starts,
    ends,
  };
}

/**
 * The source range of each child. Some mdast extensions create nodes without a position (the GFM
 * autolink literal splits trailing punctuation off a `www.` link, and the text around it loses its
 * position too); a run of such nodes covers what lies between its neighbours, divided by aligning
 * their text with that source.
 */
function inferRanges(
  children: readonly PhrasingContent[],
  text: string,
  first: number,
  bound: number,
): { s: number; e: number }[] {
  const out: ({ s: number; e: number } | null)[] = children.map((child) => {
    const s = child.position?.start.offset;
    const e = child.position?.end.offset;
    return s == null || e == null ? null : { s, e };
  });
  for (let i = 0; i < out.length; i += 1) {
    if (out[i]) continue;
    let end = i;
    while (end < out.length && !out[end]) end += 1;
    const from = i > 0 ? out[i - 1]!.e : first;
    const to = end < out.length ? out[end]!.s : bound;
    const values = children.slice(i, end).map((child) => {
      if (child.type === 'text') return child.value;
      if (child.type === 'link' && child.children.every((c) => c.type === 'text')) {
        return child.children.map((c) => (c as { value: string }).value).join('');
      }
      throw new Unsupported('no position');
    });
    const joined = values.join('');
    const map = alignValueToSource(joined, text.slice(from, to));
    if (!map) throw new Unsupported('no position');
    let at = from;
    let consumed = 0;
    values.forEach((value, k) => {
      consumed += value.length;
      const last = k === values.length - 1;
      const stop = last ? to : consumed > 0 ? from + map[consumed - 1]! + 1 : at;
      out[i + k] = { s: at, e: Math.max(at, stop) };
      at = out[i + k]!.e;
    });
    i = end - 1;
  }
  return out as { s: number; e: number }[];
}

/** Length of the delimiter run closing a mark whose source ends at `end`, at most `max`. */
function closingRun(text: string, end: number, max: number): number {
  const ch = text.charCodeAt(end - 1);
  if (ch !== 42 && ch !== 95 && ch !== 126) return 0;
  let n = 0;
  while (n < max && text.charCodeAt(end - 1 - n) === ch) n += 1;
  return n;
}

class InlineBuilder {
  nodes: PMNode[] = [];
  tokens: InlineToken[] = [];
  pm = 0;

  readonly env: Env;
  /** Offset in `env.text` of the textblock's source start. */
  readonly origin: number;
  readonly nested: boolean;

  constructor(env: Env, origin: number, nested: boolean) {
    this.env = env;
    this.origin = origin;
    this.nested = nested;
  }

  private atom(
    kind: AtomInlineKind,
    label: string,
    nStart: number,
    nEnd: number,
    marks: readonly Mark[],
  ) {
    const source = this.env.text.slice(nStart, nEnd);
    // A multi-line atom inside a container would carry the container's line prefixes.
    if (this.nested && source.includes('\n')) throw new Unsupported('multi-line inline atom');
    this.nodes.push(schema.nodes['atom_inline']!.create({ source, kind, label }, null, marks));
    this.tokens.push({
      pm: this.pm,
      len: 1,
      s: nStart - this.origin,
      e: nEnd - this.origin,
      kind: 'atom',
      marks: marksKey(marks),
    });
    this.pm += 1;
  }

  private breakNode(hard: boolean, nStart: number, nEnd: number) {
    this.nodes.push(schema.nodes[hard ? 'hard_break' : 'soft_break']!.create());
    this.tokens.push({
      pm: this.pm,
      len: 1,
      s: nStart - this.origin,
      e: nEnd - this.origin,
      kind: 'break',
      marks: '',
    });
    this.pm += 1;
  }

  /** Plain text of `value`, whose source is `env.text[nStart, nEnd)`; splits soft breaks and citations. */
  text(value: string, nStart: number, nEnd: number, marks: readonly Mark[], aligned?: Int32Array) {
    if (value.length === 0) return;
    const { env } = this;
    const map = aligned ?? alignValueToSource(value, env.text.slice(nStart, nEnd));
    if (!map) throw new Unsupported('text not aligned');
    // `alignValueToSource` is relative to the slice; make it absolute.
    const abs = aligned ? map : map.map((offset) => offset + nStart);
    const key = marksKey(marks);
    const emit = (from: number, to: number) => {
      if (to <= from) return;
      const token = textToken(env, this.origin, this.pm, value, from, to, abs, key);
      this.tokens.push(token);
      this.nodes.push(schema.text(value.slice(from, to), marks));
      this.pm += to - from;
    };
    let lineStart = 0;
    for (let i = 0; i <= value.length; i += 1) {
      if (i < value.length && value.charCodeAt(i) !== 10) continue;
      // [lineStart, i) is one line of text; find the citations in it.
      const line = value.slice(lineStart, i);
      let at = lineStart;
      for (const cite of findCitations(line)) {
        const from = lineStart + cite.index;
        const to = from + cite.length;
        emit(at, from);
        this.atom('citation', cite.keys.join(', '), abs[from]!, abs[to - 1]! + 1, marks);
        at = to;
      }
      emit(at, i);
      if (i < value.length) {
        const nl = abs[i]!;
        this.breakNode(false, nl, nl + 1);
      }
      lineStart = i + 1;
    }
  }

  /**
   * `bound` is the end offset of the parent's content. Some mdast extensions (the GFM autolink
   * literal splitting off trailing punctuation) create nodes without a position; those are
   * inferred from their neighbours.
   */
  phrasing(
    children: readonly PhrasingContent[],
    marks: readonly Mark[],
    bound: number,
    first: number,
  ) {
    const { env } = this;
    const ranges = inferRanges(children, env.text, first, bound);
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      const nStart = ranges[index]!.s;
      const nEnd = ranges[index]!.e;
      const inner = (close: number) => Math.max(nStart, nEnd - closingRun(env.text, nEnd, close));
      switch (child.type) {
        case 'text':
          this.text(child.value, nStart, nEnd, marks);
          break;
        case 'strong':
          this.phrasing(
            child.children,
            schema.marks['strong']!.create().addToSet(marks as Mark[]),
            inner(2),
            nStart,
          );
          break;
        case 'emphasis':
          this.phrasing(
            child.children,
            schema.marks['em']!.create().addToSet(marks as Mark[]),
            inner(1),
            nStart,
          );
          break;
        case 'delete':
          this.phrasing(
            child.children,
            schema.marks['strike']!.create().addToSet(marks as Mark[]),
            inner(2),
            nStart,
          );
          break;
        case 'inlineCode': {
          const slice = env.text.slice(nStart, nEnd);
          const open = /^`+/.exec(slice)?.[0].length ?? 0;
          const close = /`+$/.exec(slice)?.[0].length ?? 0;
          if (open === 0 || close === 0 || open + close > slice.length) {
            throw new Unsupported('inline code');
          }
          const inner = slice.slice(open, slice.length - close);
          const map = alignValueToSource(child.value, inner);
          if (!map) throw new Unsupported('inline code not aligned');
          const abs = map.map((offset) => offset + nStart + open);
          const codeMarks = schema.marks['code']!.create().addToSet(marks as Mark[]);
          this.text(child.value, nStart + open, nEnd - close, codeMarks, abs);
          break;
        }
        case 'link': {
          const slice = env.text.slice(nStart, nEnd);
          // Only `[text](url)` is an editable link; autolinks and bare URLs stay as atoms.
          if (slice.startsWith('[') && slice.endsWith(')')) {
            const link = schema.marks['link']!.create({
              href: child.url,
              title: child.title ?? '',
            });
            this.phrasing(child.children, link.addToSet(marks as Mark[]), nEnd, nStart + 1);
          } else {
            this.atom('link', slice, nStart, nEnd, marks);
          }
          break;
        }
        case 'break':
          this.breakNode(true, nStart, nEnd);
          break;
        case 'inlineMath' as string:
          this.atom('math', (child as unknown as { value: string }).value, nStart, nEnd, marks);
          break;
        case 'image':
        case 'imageReference':
          this.atom('image', child.alt ?? '', nStart, nEnd, marks);
          break;
        case 'linkReference':
          this.atom('reference', env.text.slice(nStart, nEnd), nStart, nEnd, marks);
          break;
        case 'footnoteReference':
          this.atom('footnote', child.label ?? child.identifier, nStart, nEnd, marks);
          break;
        case 'html':
          this.atom('html', 'HTML', nStart, nEnd, marks);
          break;
        default:
          this.atom('raw', env.text.slice(nStart, nEnd), nStart, nEnd, marks);
      }
    }
  }

  finish(): { fragment: Fragment; map: InlineMap } {
    return { fragment: Fragment.fromArray(this.nodes), map: this.tokens };
  }
}

function textblock(
  type: 'paragraph' | 'heading',
  node: Paragraph | Heading,
  env: Env,
  depth: number,
  attrs?: Record<string, unknown>,
): PMNode {
  const nStart = startOf(node);
  const builder = new InlineBuilder(env, nStart, depth > 0);
  builder.phrasing(node.children, [], endOf(node), nStart);
  const { fragment, map } = builder.finish();
  const result = schema.nodes[type]!.create(attrs ?? null, fragment);
  env.infos.set(result, { s: nStart - env.base, e: endOf(node) - env.base, map });
  return result;
}

function emptyParagraph(env: Env, at: number): PMNode {
  const result = schema.nodes['paragraph']!.create();
  env.infos.set(result, { s: at - env.base, e: at - env.base, map: [] });
  return result;
}

/** `value` of a code node, as a single token (plus the node). */
function codeBlock(node: Code, env: Env, depth: number): PMNode {
  void depth;
  const nStart = startOf(node);
  const nEnd = endOf(node);
  const slice = env.text.slice(nStart, nEnd);
  const fenced = /^ {0,3}(`{3,}|~{3,})/.exec(slice);
  let contentStart = 0;
  let contentEnd = slice.length;
  let fence = 'indent';
  if (fenced) {
    fence = fenced[1]![0]!;
    const firstNewline = slice.indexOf('\n');
    contentStart = firstNewline < 0 ? slice.length : firstNewline + 1;
    const lastNewline = slice.lastIndexOf('\n');
    const closing = new RegExp(
      `(^|\\n)[ >]*${fence === '`' ? '`' : '~'}{${fenced[1]!.length},}[ \\t]*$`,
    );
    contentEnd = lastNewline >= contentStart && closing.test(slice) ? lastNewline : slice.length;
    if (contentEnd < contentStart) contentEnd = contentStart;
  }
  const value = node.value;
  const inner = slice.slice(contentStart, contentEnd);
  let map: InlineMap = [];
  if (value.length > 0) {
    const aligned = alignValueToSource(value, inner);
    if (!aligned) throw new Unsupported('code not aligned');
    const abs = aligned.map((offset) => offset + nStart + contentStart);
    map = [textToken(env, nStart, 0, value, 0, value.length, abs, '')];
  }
  const info = [node.lang ?? '', node.meta ?? ''].filter(Boolean).join(' ');
  const textNode = value.length > 0 ? schema.text(value) : null;
  const result = schema.nodes['code_block']!.create(
    { info, fence },
    textNode ? Fragment.from(textNode) : Fragment.empty,
  );
  env.infos.set(result, { s: nStart - env.base, e: nEnd - env.base, map });
  return result;
}

function listNode(node: List, env: Env, depth: number): PMNode {
  const itemNodes: PMNode[] = [];
  for (const item of node.children) {
    if (item.checked != null) throw new Unsupported('task item');
    itemNodes.push(listItem(item, env, depth + 1));
  }
  const first = node.children[0];
  const firstSource = first ? env.text.slice(startOf(first), endOf(first)) : '';
  const tight = !node.spread && !node.children.some((item) => item.spread);
  if (node.ordered) {
    const delim = /^\d+([.)])/.exec(firstSource)?.[1] ?? '.';
    let step = 1;
    const second = node.children[1];
    if (first && second) {
      const a = Number(/^\d+/.exec(firstSource)?.[0]);
      const b = Number(/^\d+/.exec(env.text.slice(startOf(second), endOf(second)))?.[0]);
      if (Number.isFinite(a) && Number.isFinite(b) && b - a === 0) step = 0;
    }
    return schema.nodes['ordered_list']!.create(
      { start: node.start ?? 1, delim, step, tight },
      itemNodes,
    );
  }
  const marker = firstSource[0] === '*' || firstSource[0] === '+' ? firstSource[0] : '-';
  return schema.nodes['bullet_list']!.create({ marker, tight }, itemNodes);
}

function listItem(node: ListItem, env: Env, depth: number): PMNode {
  const children = node.children.map((child) => convertBlock(child, env, depth));
  if (children.length === 0) children.push(emptyParagraph(env, endOf(node)));
  return schema.nodes['list_item']!.create(null, children);
}

function convertBlock(node: RootContent, env: Env, depth: number): PMNode {
  switch (node.type) {
    case 'paragraph':
      return textblock('paragraph', node, env, depth);
    case 'heading': {
      const slice = env.text.slice(startOf(node), endOf(node));
      return textblock('heading', node, env, depth, {
        level: node.depth,
        setext: !/^ {0,3}#/.test(slice),
      });
    }
    case 'code':
      return codeBlock(node, env, depth);
    case 'blockquote': {
      if (calloutOf(node as Blockquote)) throw new Unsupported('callout');
      const children = (node as Blockquote).children.map((child) =>
        convertBlock(child, env, depth + 1),
      );
      if (children.length === 0) children.push(emptyParagraph(env, endOf(node)));
      return schema.nodes['blockquote']!.create(null, children);
    }
    case 'list':
      return listNode(node, env, depth);
    default:
      throw new Unsupported(node.type);
  }
}

function atomKindOf(node: RootContent): { kind: AtomBlockKind; label: string } {
  switch (node.type) {
    case 'table':
      return { kind: 'table', label: 'Table' };
    case 'html':
      return { kind: 'html', label: 'HTML' };
    case 'footnoteDefinition':
      return { kind: 'footnote', label: 'Footnote' };
    case 'definition':
      return { kind: 'definition', label: 'Link definition' };
    case 'thematicBreak':
      return { kind: 'rule', label: 'Horizontal rule' };
    case 'blockquote': {
      const callout = calloutOf(node);
      return callout ? { kind: 'callout', label: callout.label } : { kind: 'raw', label: 'Quote' };
    }
    default:
      if ((node.type as string) === 'math') {
        return { kind: 'math', label: (node as unknown as { value: string }).value };
      }
      return { kind: 'raw', label: 'Markdown' };
  }
}

function atomBlock(node: RootContent, source: string): PMNode {
  const { kind, label } = atomKindOf(node);
  return schema.nodes['atom_block']!.create({ source, kind, label });
}

/** The textblocks of a top-level node, with their positions, from the infos recorded at conversion. */
function collectTextblocks(top: PMNode, env: Env): TextblockInfo[] {
  const out: TextblockInfo[] = [];
  const visit = (node: PMNode, contentStart: number) => {
    node.forEach((child, offset) => {
      const childStart = contentStart + offset;
      if (child.isTextblock) {
        const info = env.infos.get(child);
        if (info) {
          out.push({
            pm: childStart + 1,
            size: child.content.size,
            s: info.s,
            e: info.e,
            map: info.map,
          });
        }
      } else if (!child.isAtom) {
        visit(child, childStart + 1);
      }
    });
  };
  if (top.isTextblock) {
    const info = env.infos.get(top);
    if (info) out.push({ pm: 1, size: top.content.size, s: info.s, e: info.e, map: info.map });
  } else if (!top.isAtom) {
    visit(top, 1);
  }
  return out;
}

/** Converts one top-level mdast block; `ns`/`ne` are its offsets in the parser's text. */
function convertTop(
  node: RootContent,
  env: Env,
  source: string,
  rewritten: boolean,
): { node: PMNode; tbs: TextblockInfo[] } {
  const editable =
    node.type === 'paragraph' ||
    node.type === 'heading' ||
    node.type === 'code' ||
    node.type === 'list' ||
    (node.type === 'blockquote' && !calloutOf(node));
  if (editable && !rewritten) {
    try {
      const converted = convertBlock(node, env, 0);
      return { node: converted, tbs: collectTextblocks(converted, env) };
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error;
      (globalThis as { __smDebug?: (...a: unknown[]) => void }).__smDebug?.(
        'unsupported',
        error.message,
      );
    }
  }
  return { node: atomBlock(node, source), tbs: [] };
}

export interface ParseOptions {
  /** Keep a virtual empty paragraph after a last block that is not a paragraph (a place to type). */
  trailingParagraph?: boolean;
}

/** An empty top-level paragraph: it has no source and no whitespace around it. */
export function virtualSegment(): Segment {
  return {
    node: schema.nodes['paragraph']!.create(),
    gap: '',
    src: '',
    tbs: [{ pm: 1, size: 0, s: 0, e: 0, map: [] }],
  };
}

export function parseDocument(text: string, options: ParseOptions = {}): ParsedDocument {
  const { trailingParagraph = true } = options;
  const normalized = normalizeDisplayMathMapped(text);
  const tree = parseTree(normalized.text);
  const segments: Segment[] = [];
  let previousEnd = 0;
  for (const child of tree.children) {
    const ns = startOf(child);
    const ne = endOf(child);
    const os = normalized.toOriginal(ns, 'start');
    const oe = normalized.toOriginal(ne, 'end');
    if (os < previousEnd || oe < os) continue;
    let gap = text.slice(previousEnd, os);
    // Text between two blocks that the parser did not put in either: kept whole, as a raw atom.
    if (/\S/.test(gap)) {
      const lead = /^\s*/.exec(gap)![0];
      const body = gap.slice(lead.length).replace(/\s+$/, '');
      const trail = gap.slice(lead.length + body.length);
      segments.push({
        node: schema.nodes['atom_block']!.create({ source: body, kind: 'raw', label: 'Markdown' }),
        gap: lead,
        src: body,
        tbs: [],
      });
      gap = trail;
    }
    const source = text.slice(os, oe);
    const rewritten = normalized.text.slice(ns, ne) !== source;
    const env: Env = { text: normalized.text, base: ns, infos: new WeakMap() };
    const converted = convertTop(child, env, source, rewritten && child.type !== 'math');
    segments.push({ node: converted.node, gap, src: source, tbs: converted.tbs });
    previousEnd = oe;
  }
  const tail = text.slice(previousEnd);
  const last = segments[segments.length - 1];
  if (!last || (trailingParagraph && last.node.type.name !== 'paragraph')) {
    segments.push(virtualSegment());
  }
  // A place to type before a first block that cannot hold the caret (a table, a formula...).
  if (trailingParagraph && segments[0]!.node.type.name === 'atom_block') {
    segments.unshift(virtualSegment());
  }
  const doc = schema.nodes['doc']!.create(
    null,
    segments.map((segment) => segment.node),
  );
  return { segments, tail, doc };
}

/**
 * Where the markers of the top-level list in `source` are: the offset of the bullet character, or of
 * the delimiter after the number, of each item. `null` when the source is not one list. Used to
 * change a list's marker without writing the list again.
 */
export function listMarkerOffsets(source: string): { offsets: number[]; ordered: boolean } | null {
  const tree = processor.parse(source) as Root;
  const first = tree.children[0];
  if (tree.children.length !== 1 || first?.type !== 'list') return null;
  const offsets: number[] = [];
  for (const item of first.children) {
    const at = item.position?.start.offset;
    if (at == null) return null;
    if (first.ordered) {
      const digits = /^\d+/.exec(source.slice(at))?.[0].length ?? 0;
      offsets.push(at + digits);
    } else offsets.push(at);
  }
  return { offsets, ordered: first.ordered === true };
}
