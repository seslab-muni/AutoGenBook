import type { Node as PMNode } from 'prosemirror-model';

import { marksKey } from './parse';

/**
 * What an edited block means, as a string, for deciding whether the source written for it reads
 * back as the same thing (the serializer's safety net: every edited block is parsed again and
 * compared). It deliberately ignores what Markdown does not preserve or that the serializer is free
 * to choose: marker characters, list tightness, escapes, edge whitespace, whitespace around line
 * breaks, marks on whitespace-only runs. An atom and the literal text of its source are the same
 * thing (typing `$x$` is text until the block is parsed again).
 */

interface Run {
  t: string;
  m: string;
}

const WS = /[ \t]/;
const HARD = '\u0000';

function inlineRuns(node: PMNode): Run[] {
  const runs: Run[] = [];
  node.forEach((child) => {
    const m = marksKey(child.marks);
    if (child.isText) runs.push({ t: child.text!, m });
    else if (child.type.name === 'atom_inline')
      runs.push({ t: child.attrs['source'] as string, m });
    else if (child.type.name === 'soft_break') runs.push({ t: '\n', m: '' });
    else if (child.type.name === 'hard_break') runs.push({ t: HARD, m: '' });
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

const isCode = (marks: string) => marks.split(',').includes('code');

/** Inline content, normalised: see the file comment. */
export function inlineFingerprint(node: PMNode): [string, string][] {
  const runs = mergeRuns(inlineRuns(node));
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
    kept.push({ t: piece, m: run.m });
  }
  // Whitespace at the edge of a marked run belongs to the text around it: Markdown cannot open or
  // close emphasis next to a space, so where the space sits is the serializer's choice (code is exact).
  const canonical: Run[] = [];
  for (const run of kept) {
    if (run.m === '' || isCode(run.m) || run.t === '') {
      canonical.push(run);
      continue;
    }
    const lead = /^[ \t]*/.exec(run.t)![0];
    const trail = lead.length === run.t.length ? '' : /[ \t]*$/.exec(run.t)![0];
    const core = run.t.slice(lead.length, run.t.length - trail.length);
    if (lead) canonical.push({ t: lead, m: '' });
    if (core) canonical.push({ t: core, m: run.m });
    if (trail) canonical.push({ t: trail, m: '' });
  }
  return mergeRuns(canonical).map((run) => [run.t, run.m]);
}

/**
 * The children of a container as data. An empty paragraph next to other content has no Markdown
 * form (blank lines separate blocks, they are not blocks), so it means nothing; the only child of an
 * item or a quote keeps its meaning (an empty item).
 */
function listItemChildren(node: PMNode): unknown[] {
  const out: unknown[] = [];
  node.forEach((child) => {
    if (child.type.name === 'paragraph' && child.content.size === 0 && node.childCount > 1) return;
    out.push(blockFingerprint(child));
  });
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
      return ['a', node.attrs['source']];
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
    // A paragraph of literal text that is, as source, a display-math block (typing `$$x$$`): the
    // text is kept as typed and becomes the formula the next time the block is parsed.
    if (
      a.type.name === 'paragraph' &&
      b.type.name === 'atom_block' &&
      b.attrs['kind'] === 'math' &&
      a.textContent.trim() === (b.attrs['source'] as string).trim() &&
      !a.content.content.some((child) => !child.isText)
    ) {
      continue;
    }
    return false;
  }
  return true;
}
