import type { Mark, Node as PMNode } from 'prosemirror-model';

import { marksKey } from './parse';

/**
 * What an edited block means, as a string, for deciding whether the source written for it reads
 * back as the same thing (the serializer's safety net: every edited block is parsed again and
 * compared). It deliberately ignores what Markdown does not preserve or that the serializer is free
 * to choose: marker characters, list tightness, escapes, edge whitespace, whitespace around line
 * breaks, marks on whitespace and punctuation at the edge of emphasised text. A formula, a citation
 * and an automatic link are the same thing as their literal source (typing `$x$` is text until the
 * block is parsed again), and so is a reference to a definition or a footnote; no other atom is.
 */

interface Run {
  t: string;
  m: string;
  marks: readonly Mark[];
}

const WS = /[ \t]/;
const HARD = '\u0000';
// eslint-disable-next-line no-control-regex
const BREAKS = /[\n\u0000]{2,}/g;
const EDGE_LEAD = /^[\p{Zs}\t\p{P}\p{S}]*/u;
const EDGE_TRAIL = /[\p{Zs}\t\p{P}\p{S}]*$/u;

/** Whether math source `$...$` reads as formula by the rule the editor writes it by (see `serialize.ts`). */
export function isCleanMath(source: string): boolean {
  if (source.includes('\n')) return false;
  const open = /^\$+/.exec(source)?.[0].length ?? 0;
  const close = /\$+$/.exec(source)?.[0].length ?? 0;
  if (open === 0 || open !== close || open * 2 >= source.length) return false;
  const inner = source.slice(open, source.length - close);
  return !/^\s|\s$/.test(inner) && !inner.includes('$');
}

/**
 * What an atom is worth as text. Only a formula (written the way the editor writes formulas), a
 * citation and an automatic link are the same thing as their literal source: typing one of them is
 * text until the block is parsed again. Anything else (inline HTML, an image, a reference link, a
 * footnote reference) is a construct of its own: text that would read back as one is not equal.
 */
function atomText(kind: string, source: string): string {
  // (A reference link or a footnote reference means what the definitions in the rest of the draft
  // say, which a block read on its own cannot know: the serializer keeps literal text from becoming
  // one by escaping the brackets of every label that is defined.)
  if (kind === 'link') {
    // (`<https://x.y>` is the address `https://x.y`.)
    const angle = /^<([^<>\s]+)>$/.exec(source);
    return (angle ? angle[1]! : source).replace(/\\(?=[!-/:-@[-`{-~])/g, '');
  }
  if (kind === 'citation' || kind === 'reference' || kind === 'footnote') return source;
  if (kind === 'math' && isCleanMath(source)) return source;
  return `\u0001${kind}\u0002${source}\u0001`;
}

function inlineRuns(node: PMNode, inHeading: boolean): Run[] {
  const runs: Run[] = [];
  node.forEach((child) => {
    const m = marksKey(child.marks);
    if (child.isText) runs.push({ t: child.text!, m, marks: child.marks });
    else if (child.type.name === 'atom_inline') {
      runs.push({
        t: atomText(child.attrs['kind'] as string, child.attrs['source'] as string),
        m,
        marks: child.marks,
      });
    } else if (child.type.name === 'soft_break') {
      runs.push({ t: inHeading ? ' ' : '\n', m: '', marks: [] });
    } else if (child.type.name === 'hard_break') {
      runs.push({ t: inHeading ? ' ' : HARD, m: '', marks: [] });
    }
  });
  return runs;
}

function mergeRuns(runs: readonly Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (run.t.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.m === run.m) last.t += run.t;
    else out.push({ ...run });
  }
  return out;
}

/** A paragraph of nothing but spaces and line breaks: it has no source (like an empty one, it is where the caret can be). */
export function isBlankParagraph(node: PMNode): boolean {
  if (node.type.name !== 'paragraph') return false;
  let blank = true;
  node.forEach((child) => {
    const type = child.type.name;
    if (type === 'soft_break' || type === 'hard_break') return;
    if (!child.isText || !/^[ \t\n]*$/.test(child.text!)) blank = false;
  });
  return blank;
}

const isCode = (marks: readonly Mark[]) => marks.some((mark) => mark.type.name === 'code');

/** Inline content, normalised: see the file comment. */
export function inlineFingerprint(node: PMNode): [string, string][] {
  const runs = mergeRuns(inlineRuns(node, node.type.name === 'heading'));
  const text = runs.map((run) => run.t).join('');
  const droppable = (c: string | undefined) =>
    c !== undefined && (WS.test(c) || c === '\n' || c === HARD);
  // Characters to drop: edge whitespace and line breaks, and spaces around a line break.
  const drop = new Uint8Array(text.length);
  let start = 0;
  while (start < text.length && droppable(text[start])) {
    drop[start] = 1;
    start += 1;
  }
  let end = text.length;
  while (end > start && droppable(text[end - 1])) {
    drop[end - 1] = 1;
    end -= 1;
  }
  for (let i = start; i < end; i += 1) {
    const c = text[i]!;
    if (c !== '\n' && c !== HARD) continue;
    for (let j = i - 1; j >= start && WS.test(text[j]!); j -= 1) drop[j] = 1;
    for (let j = i + 1; j < end && WS.test(text[j]!); j += 1) drop[j] = 1;
  }
  const kept: Run[] = [];
  let at = 0;
  for (const run of runs) {
    let piece = '';
    for (let i = 0; i < run.t.length; i += 1) if (!drop[at + i]) piece += run.t[i];
    at += run.t.length;
    kept.push({ t: piece, m: run.m, marks: run.marks });
  }
  // Whitespace and punctuation at the edge of an emphasised run belong to the text around it:
  // Markdown cannot open or close emphasis next to a space, and next to punctuation only when a
  // letter does not follow (`**「重要」**です`), so where they sit is the serializer's choice (code
  // and links are exact).
  const canonical: Run[] = [];
  for (const run of kept) {
    if (run.m === '' || isCode(run.marks) || run.t === '') {
      canonical.push(run);
      continue;
    }
    const outer = run.marks.filter((mark) => mark.type.name === 'link');
    const outerRun = (t: string): Run => ({ t, m: marksKey(outer), marks: outer });
    const lead = EDGE_LEAD.exec(run.t)![0];
    const trail = lead.length === run.t.length ? '' : EDGE_TRAIL.exec(run.t)![0];
    const core = run.t.slice(lead.length, run.t.length - trail.length);
    if (lead) canonical.push(outerRun(lead));
    if (core) canonical.push({ t: core, m: run.m, marks: run.marks });
    if (trail) canonical.push(outerRun(trail));
  }
  // (Two line breaks in a row have no Markdown form: one stays.)
  return mergeRuns(canonical).map((run) => [
    run.t.replace(BREAKS, (breaks) => (breaks.includes(HARD) ? HARD : '\n')),
    run.m,
  ]);
}

/**
 * The children of a container as data. An empty paragraph next to other content has no Markdown
 * form (blank lines separate blocks, they are not blocks), so it means nothing; the only child of an
 * item or a quote keeps its meaning (an empty item).
 */
function listItemChildren(node: PMNode): unknown[] {
  const out: unknown[] = [];
  node.forEach((child) => {
    if (isBlankParagraph(child)) return;
    out.push(blockFingerprint(child));
  });
  // (Nothing but blank paragraphs: an empty item or quote.)
  if (out.length === 0 && node.childCount > 0) out.push(['p', []]);
  return out;
}

/** The meaning of a block as plain data. */
export function blockFingerprint(node: PMNode): unknown {
  switch (node.type.name) {
    case 'paragraph':
      return ['p', inlineFingerprint(node)];
    case 'heading':
      return ['h', node.attrs['level'], inlineFingerprint(node)];
    case 'code_block':
      return ['c', (node.attrs['info'] as string).trim(), node.textContent];
    case 'blockquote':
    case 'list_item':
      return [node.type.name === 'blockquote' ? 'q' : 'li', ...listItemChildren(node)];
    case 'bullet_list':
      return ['ul', ...listItemChildren(node)];
    case 'ordered_list':
      return ['ol', node.attrs['start'], ...listItemChildren(node)];
    case 'atom_block':
      return ['a', (node.attrs['source'] as string).replace(/\s+$/, '')];
    default:
      return [node.type.name];
  }
}

export function fingerprintString(node: PMNode): string {
  return JSON.stringify(blockFingerprint(node));
}

/** Whether `parsed` (what the source reads back as) is what `intended` (the edited blocks) means. */
export function sameMeaning(intended: readonly PMNode[], parsed: readonly PMNode[]): boolean {
  if (intended.length !== parsed.length) return false;
  for (let i = 0; i < intended.length; i += 1) {
    const a = intended[i]!;
    const b = parsed[i]!;
    if (fingerprintString(a) === fingerprintString(b)) continue;
    // A paragraph of literal text that is, as source, a closed one-line display formula (typing
    // `$$x$$`): the text is kept as typed and becomes the formula the next time the block is parsed.
    if (
      a.type.name === 'paragraph' &&
      b.type.name === 'atom_block' &&
      b.attrs['kind'] === 'math' &&
      /^\$\$[^\n$]+\$\$$/.test((b.attrs['source'] as string).trim()) &&
      a.textContent.trim() === (b.attrs['source'] as string).trim() &&
      !a.content.content.some((child) => !child.isText)
    ) {
      continue;
    }
    return false;
  }
  return true;
}
