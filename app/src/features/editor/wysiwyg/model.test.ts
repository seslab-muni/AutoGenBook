import { describe, expect, it } from 'vitest';

import sample from '@/features/editor/__fixtures__/sample-section.md?raw';

import { EditorCore } from './core';
import { parseDocument } from './parse';
import { randomDocument } from './test-docs';

describe('parseDocument keeps the source byte for byte', () => {
  it('reproduces the sample section', () => {
    const parsed = parseDocument(sample);
    expect(parsed.segments.map((s) => s.gap + s.src).join('') + parsed.tail).toBe(sample);
  });

  it('reproduces 400 random documents', () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const text = randomDocument(seed);
      const parsed = parseDocument(text);
      const rebuilt = parsed.segments.map((s) => s.gap + s.src).join('') + parsed.tail;
      if (rebuilt !== text) throw new Error(`seed ${seed}: ${JSON.stringify(text)}`);
      const core = new EditorCore(text);
      expect(core.text).toBe(text);
      expect(core.doc.childCount).toBe(parsed.segments.length);
    }
  });
});

import type { Node as PMNode } from 'prosemirror-model';

import { fingerprintString } from './equivalence';
import { schema } from './schema';
import { rng } from './test-docs';

/** Positions inside editable text of top-level block `index`. */
function textPositions(doc: PMNode, index: number): number[] {
  let start = 0;
  for (let i = 0; i < index; i += 1) start += doc.child(i).nodeSize;
  const out: number[] = [];
  doc.child(index).descendants((node, pos) => {
    if (node.isTextblock) {
      for (let k = 0; k <= node.content.size; k += 1) out.push(start + pos + 1 + 1 + k);
    }
    return !node.isTextblock;
  });
  // The top-level node itself being a textblock.
  if (doc.child(index).isTextblock) {
    out.length = 0;
    for (let k = 0; k <= doc.child(index).content.size; k += 1) out.push(start + 1 + k);
  }
  return out;
}

function meanings(doc: PMNode): string[] {
  const out: string[] = [];
  doc.forEach((node) => {
    if (node.type.name === 'paragraph' && node.content.size === 0) return;
    out.push(fingerprintString(node));
  });
  return out;
}

describe('single-block edits touch only that block', () => {
  it('inserts, deletes, splits and marks in random documents', () => {
    let edits = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const text = randomDocument(seed);
      const core = new EditorCore(text);
      const next = rng(seed * 7919);
      const candidates: number[] = [];
      for (let i = 0; i < core.doc.childCount; i += 1) {
        if (textPositions(core.doc, i).length > 0 && core.doc.child(i).type.name !== 'atom_block') {
          candidates.push(i);
        }
      }
      if (candidates.length === 0) continue;
      const index = candidates[Math.floor(next() * candidates.length)]!;
      const positions = textPositions(core.doc, index);
      const pos = positions[Math.floor(next() * positions.length)]!;
      const before = core.model.text;
      const segs = core.model.segments;
      const oldSrcStart =
        segs.slice(0, index).reduce((n, s) => n + s.gap.length + s.src.length, 0) +
        segs[index]!.gap.length;
      const oldSrcEnd = oldSrcStart + segs[index]!.src.length;

      const op = Math.floor(next() * 3);
      let tr = core.state.tr;
      if (op === 0) tr = tr.insertText('ab', pos);
      else if (op === 1) {
        const $pos = core.doc.resolve(pos);
        if ($pos.parent.isTextblock && pos > $pos.start()) tr = tr.delete(pos - 1, pos);
        else tr = tr.insertText('z', pos);
      } else {
        const $pos = core.doc.resolve(pos);
        if ($pos.parent.isTextblock && $pos.depth === 1 && $pos.parent.type.name === 'paragraph')
          tr = tr.split(pos);
        else tr = tr.insertText(' q', pos);
      }
      const result = core.apply(tr);
      if (!result.ok)
        throw new Error(`seed ${seed} op ${op}: refused for ${JSON.stringify(before)}`);
      edits += 1;
      const after = result.text;
      expect(after.slice(0, oldSrcStart), `seed ${seed} prefix`).toBe(before.slice(0, oldSrcStart));
      expect(
        after.endsWith(before.slice(oldSrcEnd)),
        `seed ${seed} suffix ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
      ).toBe(true);
      expect(core.model.text).toBe(core.model.join());
      // What the source now says is what the editor shows.
      const reparsed = new EditorCore(after);
      expect(meanings(reparsed.doc), `seed ${seed}: ${JSON.stringify(after)}`).toEqual(
        meanings(core.doc),
      );
    }
    expect(edits).toBeGreaterThan(150);
  });
});

void schema;
