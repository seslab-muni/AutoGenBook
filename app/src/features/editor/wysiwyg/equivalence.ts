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

/** Inline content, normalised: see the file comment. */
export function inlineFingerprint(node: PMNode): [string, string][] {
  const runs = mergeRuns(inlineRuns(node));
  const text = runs.map((run) => run.t).join('');
  // Characters to drop: edge whitespace, and spaces around a line break.
  const drop = new Uint8Array(text.length);
  let start = 0;
  while (start < text.length && (WS.test(text[start]!) || text[start] === '\n')) {
    drop[start] = 1;
    start += 1;
  }
  let end = text.length;
  while (end > start && (WS.test(text[end - 1]!) || text[end - 1] === '\n')) {
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
  // Marks on whitespace-only runs mean nothing in Markdown.
  const plain = mergeRuns(kept.map((run) => (run.t.trim() === '' ? { t: run.t, m: '' } : run)));
  return plain.map((run) => [run.t, run.m]);
}

function listItemChildren(node: PMNode): unknown[] {
  const out: unknown[] = [];
  node.forEach((child) => out.push(blockFingerprint(child)));
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
