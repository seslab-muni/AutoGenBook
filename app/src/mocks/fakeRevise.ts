import { CodePointIndex } from '@/features/editor/lib/anchors';
import type { Hunk } from '@/features/editor/lib/card-payloads';
import type { RevisionParams } from '@/api/types';

/**
 * A stand-in for `engine.revise`: deterministic edits chosen from the request's chips and
 * instruction, returned in the shape the API stores (`hunks` in Unicode code points over the
 * original, `original[start:end] == removed`), so the mock exercises the real diff and accept paths.
 */
export interface FakeRevision {
  replacement: string;
  hunks: Hunk[];
  summary: string;
  changesMade: string[];
  warnings: string[];
  droppedCitations: string[];
}

const SYNONYMS: [string, string][] = [
  ['guarantees', 'ensures'],
  ['yields', 'produces'],
  ['defines', 'specifies'],
  ['consider', 'examine'],
  ['requires', 'demands'],
  ['satisfies', 'fulfils'],
];

interface Edit {
  /** UTF-16 offsets into the original. */
  start: number;
  end: number;
  added: string;
  note: string;
}

function additions(params: RevisionParams, instruction: string): { text: string; note: string }[] {
  const out: { text: string; note: string }[] = [];
  if (params.moreProofs) {
    out.push({
      text: ' Proof sketch (𝒫): assume the claim fails and derive a contradiction from the previous step.',
      note: 'Added a short proof sketch.',
    });
  }
  if (params.moreExamples) {
    out.push({
      text: ' For example, take a two-state instance and check each case by hand.',
      note: 'Added a worked example.',
    });
  }
  if (params.moreRigorous) {
    out.push({
      text: ' Formally, every step above holds for all admissible inputs.',
      note: 'Made the argument more rigorous.',
    });
  }
  if (params.citeSources) {
    out.push({ text: ' This agrees with prior work [@castro2002].', note: 'Cited a source.' });
  }
  if ((params.fixIssueIds?.length ?? 0) > 0) {
    out.push({
      text: ' (Revised to address the reviewer’s note.)',
      note: 'Addressed review issues.',
    });
  }
  if ((params.addressCommentIds?.length ?? 0) > 0) {
    out.push({ text: ' (Revised in answer to the comments.)', note: 'Addressed comments.' });
  }
  if (out.length === 0 && instruction.trim() !== '') {
    out.push({
      text: ` As requested (“${instruction.trim().slice(0, 60)}”), a clarifying remark follows here.`,
      note: 'Applied the instruction.',
    });
  }
  return out;
}

function insertionPoint(text: string, from: number, to: number): number {
  // Just before trailing whitespace of the region.
  let end = to;
  while (end > from && /\s/.test(text.charAt(end - 1))) end -= 1;
  return end;
}

/** `range` is in code points over `original`; `null` revises the whole section. */
export function fakeRevise(
  original: string,
  range: { start: number; end: number } | null,
  request: { instruction: string; params: RevisionParams },
): FakeRevision {
  const index = new CodePointIndex(original);
  const from = range ? index.toUnit(range.start) : 0;
  const to = range ? index.toUnit(range.end) : original.length;
  const region = original.slice(from, to);
  const edits: Edit[] = [];
  const params = request.params;

  for (const [word, replacement] of SYNONYMS) {
    const match = new RegExp(`\\b${word}\\b`).exec(region);
    if (match) {
      edits.push({
        start: from + match.index,
        end: from + match.index + word.length,
        added: replacement,
        note: `Replaced “${word}” with “${replacement}”.`,
      });
      break;
    }
  }

  if (params.shorter) {
    const sentences = region.match(/[^.!?]+[.!?]+\s*/g) ?? [];
    const last = sentences[sentences.length - 1];
    if (sentences.length > 1 && last) {
      const start = from + region.lastIndexOf(last);
      edits.push({
        start,
        end: start + last.length,
        added: '',
        note: 'Dropped the last sentence.',
      });
    }
  } else {
    const adds = additions(params, request.instruction);
    if (range) {
      const at = insertionPoint(original, from, to);
      const text = adds.map((add) => add.text).join('');
      if (text)
        edits.push({ start: at, end: at, added: text, note: adds.map((a) => a.note).join(' ') });
    } else {
      // Section scope: the first addition after the first paragraph, the rest at the very end.
      const firstBreak = original.indexOf('\n\n', original.indexOf('\n') + 1);
      const secondBreak = firstBreak === -1 ? -1 : original.indexOf('\n\n', firstBreak + 2);
      const early = insertionPoint(original, 0, secondBreak === -1 ? original.length : secondBreak);
      adds.forEach((add, i) => {
        const at = i === 0 ? early : insertionPoint(original, 0, original.length);
        edits.push({ start: at, end: at, added: add.text, note: add.note });
      });
    }
  }

  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  // Merge touching insertions at the same place, drop overlaps.
  const clean: Edit[] = [];
  for (const edit of edits) {
    const prev = clean[clean.length - 1];
    if (prev && edit.start < prev.end) continue;
    if (prev && prev.start === prev.end && edit.start === prev.start && edit.end === edit.start) {
      prev.added += edit.added;
      prev.note += ` ${edit.note}`;
      continue;
    }
    clean.push({ ...edit });
  }

  let replacement = '';
  let cursor = 0;
  const hunks: Hunk[] = [];
  for (const edit of clean) {
    replacement += original.slice(cursor, edit.start) + edit.added;
    cursor = edit.end;
    hunks.push({
      start: index.toCp(edit.start),
      end: index.toCp(edit.end),
      removed: original.slice(edit.start, edit.end),
      added: edit.added,
    });
  }
  replacement += original.slice(cursor);

  return {
    replacement,
    hunks,
    summary:
      clean.length === 0
        ? 'No changes were needed.'
        : clean
            .map((edit) => edit.note)
            .join(' ')
            .slice(0, 240),
    changesMade: clean.map((edit) => edit.note),
    warnings: params.citeSources ? ['Only sources of the last run were searched.'] : [],
    droppedCitations: params.citeSources ? ['unknownKey2099'] : [],
  };
}

const CONTEXT = 32;

/**
 * Applies the chosen `hunks` (code points over `original`) to `current`, the text now stored, the
 * way the API does: where `current` is the original every hunk lands at its offset; otherwise each
 * hunk's window (context, removed text, context) must occur exactly once in `current`, else the
 * suggestion is `stale` (`null`).
 */
export function applyHunksTo(
  original: string,
  hunks: readonly Hunk[],
  current: string,
): string | null {
  const index = new CodePointIndex(original);
  const spans = hunks.map((hunk) => ({
    start: index.toUnit(hunk.start),
    end: index.toUnit(hunk.end),
    added: hunk.added,
  }));
  if (current === original) return splice(original, spans);
  const placed: { start: number; end: number; added: string }[] = [];
  for (const span of spans) {
    const before = original.slice(Math.max(0, span.start - CONTEXT), span.start);
    const removed = original.slice(span.start, span.end);
    const after = original.slice(span.end, span.end + CONTEXT);
    const window = before + removed + after;
    const first = current.indexOf(window);
    if (first === -1 || current.indexOf(window, first + 1) !== -1) return null;
    const start = first + before.length;
    placed.push({ start, end: start + removed.length, added: span.added });
  }
  placed.sort((a, b) => a.start - b.start);
  for (let i = 1; i < placed.length; i += 1) {
    if (placed[i]!.start < placed[i - 1]!.end) return null;
  }
  return splice(current, placed);
}

function splice(text: string, spans: readonly { start: number; end: number; added: string }[]) {
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + span.added;
    cursor = span.end;
  }
  return out + text.slice(cursor);
}
