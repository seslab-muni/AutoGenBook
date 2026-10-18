import { splitBlock, toggleMark } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import type { Node as PMNode } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { TextSelection, type Command } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';

import { EditorCore } from './core';
import { fingerprintString } from './equivalence';
import { parseDocument } from './parse';
import { schema } from './schema';
import { randomDocument, rng } from './test-docs';

const withHistory = (text: string) => new EditorCore(text, [history()]);

/** Position of the `n`th occurrence of `needle` in the editor's text, counted in editor positions. */
function posOf(core: EditorCore, needle: string, offset = 0): number {
  let found = -1;
  core.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return found < 0;
    const i = node.text!.indexOf(needle);
    if (i >= 0) found = pos + i;
    return false;
  });
  if (found < 0) throw new Error(`no text ${needle}`);
  return found + offset;
}

function select(core: EditorCore, from: number, to = from) {
  const tr = core.state.tr.setSelection(TextSelection.create(core.doc, from, to));
  const applied = core.apply(tr);
  if (!applied.ok) throw new Error('selection refused');
}

function run(core: EditorCore, command: Command) {
  let result: ReturnType<EditorCore['apply']> | null = null;
  const ran = command(core.state, (tr) => {
    result = core.apply(tr);
  });
  if (!ran) throw new Error('the command did not apply');
  return result as ReturnType<EditorCore['apply']> | null;
}

const insert = (core: EditorCore, text: string, at: number, to = at) => {
  const result = core.apply(core.state.tr.insertText(text, at, to));
  if (!result.ok) throw new Error(`refused: ${text}`);
  return result;
};

describe('opening and not editing', () => {
  it('changes nothing: the text is the input, and no source change is reported', () => {
    for (const text of [
      '',
      '\n',
      'Hello\n',
      '# h\n\n- a\n- b\n\n$$x$$\n\n| a |\n| - |\n| 1 |',
      randomDocument(7),
    ]) {
      const core = new EditorCore(text);
      expect(core.text).toBe(text);
      expect(core.model.join()).toBe(text);
    }
  });

  it('a selection change is not a source change', () => {
    const core = new EditorCore('Hello world\n');
    const result = core.apply(core.state.tr.setSelection(TextSelection.create(core.doc, 3, 6)));
    expect(result).toMatchObject({ ok: true, docChanged: false, changes: [] });
    expect(core.text).toBe('Hello world\n');
  });
});

describe('typing and deleting change the source by exactly that text', () => {
  it('keeps the style of the block: _emphasis_, entities, escapes, hard breaks, trailing spaces', () => {
    const text = 'Hello _emph_ &amp; \\*lit\\* done  \nnext line\n\nOther\n';
    const core = new EditorCore(text);
    const result = insert(core, 'XYZ', posOf(core, 'Hello', 2));
    expect(result.text).toBe('HeXYZllo _emph_ &amp; \\*lit\\* done  \nnext line\n\nOther\n');
    expect(result.changes).toEqual([{ from: 2, to: 2, insertedLength: 3 }]);
  });

  it('types inside emphasis, a link and a code span without touching the delimiters', () => {
    const text = 'a **bold** b [link](https://x.y "t") c `code` d\n';
    const core = new EditorCore(text);
    expect(insert(core, '1', posOf(core, 'bold', 2)).text).toContain('**bo1ld**');
    expect(insert(core, '2', posOf(core, 'link', 2)).text).toContain('[li2nk](https://x.y "t")');
    expect(insert(core, '3', posOf(core, 'code', 2)).text).toContain('`co3de`');
    expect(core.text).toBe('a **bo1ld** b [li2nk](https://x.y "t") c `co3de` d\n');
  });

  it('escapes typed text only where it would otherwise mean something', () => {
    const core = new EditorCore('Hello world\n');
    // A lone star cannot open emphasis, so it stays as typed...
    expect(insert(core, '*', posOf(core, 'Hello', 5)).text).toBe('Hello* world\n');
    // ...but typed as a pair they would be emphasis, so they are escaped.
    expect(insert(core, '*y*', posOf(core, 'world', 5)).text).toBe('Hello* world\\*y\\*\n');
  });

  it('keeps typed $ and [@ as they are (they are formulas and citations when the block is read again)', () => {
    const core = new EditorCore('Hello world\n');
    expect(insert(core, ' $x$ [@k]', posOf(core, 'world', 5)).text).toBe('Hello world $x$ [@k]\n');
  });

  it('does not write spaces typed at the start of a line (four of them would make code)', () => {
    const core = new EditorCore('Hello\n');
    const before = core.text;
    const result = core.apply(core.state.tr.insertText('    ', 1));
    expect(result.ok).toBe(true);
    expect(core.text).toBe(before);
    expect(core.doc.firstChild!.textContent).toBe('    Hello');
    // Typing on after them writes the text, at the start of the line.
    insert(core, 'X', 5);
    expect(core.text).toBe('XHello\n');
  });

  it('deletes a range inside one run, and a whole run with the delimiters around it', () => {
    const core = new EditorCore('a **bold** b and more\n');
    const from = posOf(core, 'bold', 1);
    expect(core.apply(core.state.tr.delete(from, from + 2)).ok).toBe(true);
    expect(core.text).toBe('a **bd** b and more\n');
    const all = posOf(core, 'bd');
    expect(core.apply(core.state.tr.delete(all, all + 2)).ok).toBe(true);
    expect(core.text).toBe('a  b and more\n');
  });

  it('replaces a selection with typed text', () => {
    const core = new EditorCore('Hello wonderful world\n');
    const from = posOf(core, 'wonderful');
    expect(insert(core, 'big', from, from + 'wonderful'.length).text).toBe('Hello big world\n');
  });

  it('writes the block again when the typed text does not match the run it lands in (no silent mismatch)', () => {
    const core = new EditorCore('a **bold** b\n');
    // Typing plain text right after the bold run, with no marks: the serializer decides.
    const at = posOf(core, 'bold', 4);
    const result = core.apply(core.state.tr.insert(at, schema.text('X')));
    expect(result.ok).toBe(true);
    expect(core.text).toBe('a **bold**X b\n');
  });

  it('types into code blocks, lists and quotes in place', () => {
    const core = new EditorCore('- one\n- two\n  - three\n\n> quote\n\n```\ncode\n```\n');
    insert(core, '1', posOf(core, 'two', 1));
    insert(core, '2', posOf(core, 'three', 1));
    insert(core, '3', posOf(core, 'quote', 1));
    insert(core, '4', posOf(core, 'code', 1));
    expect(core.text).toBe('- one\n- t1wo\n  - t2hree\n\n> q3uote\n\n```\nc4ode\n```\n');
  });

  it('keeps the other blocks and the whitespace between them byte for byte', () => {
    const text = '\n# T\n\n\nfirst\n\n\n\nsecond  \n\nthird\n\n';
    const core = new EditorCore(text);
    const result = insert(core, 'X', posOf(core, 'second', 3));
    expect(result.text).toBe('\n# T\n\n\nfirst\n\n\n\nsecXond  \n\nthird\n\n');
  });
});

describe('structural edits write only the blocks that changed', () => {
  it('Enter at the end of a paragraph changes nothing until something is typed', () => {
    const core = new EditorCore('first\n\nsecond\n');
    select(core, posOf(core, 'first', 5));
    const result = run(core, splitBlock);
    expect(result).toMatchObject({ ok: true, changes: [] });
    expect(core.text).toBe('first\n\nsecond\n');
    expect(core.doc.childCount).toBe(3);
    insert(core, 'new', core.state.selection.from);
    expect(core.text).toBe('first\n\nnew\n\nsecond\n');
  });

  it('Enter in the middle of a paragraph splits it with a blank line', () => {
    const core = new EditorCore('Hello world\n\nnext\n');
    select(core, posOf(core, 'Hello', 5));
    run(core, splitBlock);
    // The second paragraph keeps the space that followed the caret in the editor; the source does not
    // write it (a space at the start of a line means nothing, and four of them would be code).
    expect(core.text).toBe('Hello\n\nworld\n\nnext\n');
  });

  it('typing after the last block appends it before the closing newline', () => {
    const core = new EditorCore('only\n');
    select(core, posOf(core, 'only', 4));
    run(core, splitBlock);
    insert(core, 'more', core.state.selection.from);
    expect(core.text).toBe('only\n\nmore\n');
  });

  it('joining two paragraphs drops the gap between them', () => {
    const core = new EditorCore('one\n\ntwo\n\nthree\n');
    const end = posOf(core, 'one', 3);
    expect(core.apply(core.state.tr.join(end + 1)).ok).toBe(true);
    expect(core.text).toBe('onetwo\n\nthree\n');
  });

  it('deleting a block removes it and one gap', () => {
    const core = new EditorCore('one\n\ntwo\n\nthree\n');
    const from = posOf(core, 'two') - 1;
    expect(core.apply(core.state.tr.delete(from, from + 5)).ok).toBe(true);
    expect(core.text).toBe('one\n\nthree\n');
  });

  it('deleting the first block keeps the leading whitespace of the document', () => {
    const core = new EditorCore('\n\none\n\ntwo\n');
    const from = posOf(core, 'one') - 1;
    expect(core.apply(core.state.tr.delete(from, from + 5)).ok).toBe(true);
    expect(core.text).toBe('\n\ntwo\n');
  });

  it('toggles a mark over a selection and writes just that block', () => {
    const core = new EditorCore('before\n\nHello big world\n\nafter\n');
    const from = posOf(core, 'big');
    select(core, from, from + 3);
    run(core, toggleMark(schema.marks['strong']!));
    expect(core.text).toBe('before\n\nHello **big** world\n\nafter\n');
    run(core, toggleMark(schema.marks['strong']!));
    expect(core.text).toBe('before\n\nHello big world\n\nafter\n');
  });

  it('turns a paragraph into a list, and indents and outdents items', () => {
    const core = new EditorCore('intro\n\nalpha\n\nomega\n');
    select(core, posOf(core, 'alpha', 1));
    run(core, wrapInList(schema.nodes['bullet_list']!));
    expect(core.text).toBe('intro\n\n- alpha\n\nomega\n');
    // A second item, indented under the first.
    select(core, posOf(core, 'alpha', 5));
    run(core, splitListItem(schema.nodes['list_item']!));
    insert(core, 'beta', core.state.selection.from);
    expect(core.text).toBe('intro\n\n- alpha\n- beta\n\nomega\n');
    run(core, sinkListItem(schema.nodes['list_item']!));
    expect(core.text).toBe('intro\n\n- alpha\n  - beta\n\nomega\n');
    run(core, liftListItem(schema.nodes['list_item']!));
    expect(core.text).toBe('intro\n\n- alpha\n- beta\n\nomega\n');
  });

  it('keeps two lists that end up next to each other apart (a different marker)', () => {
    const core = new EditorCore('- a\n\nbetween\n\n- b\n');
    const from = posOf(core, 'between') - 1;
    expect(core.apply(core.state.tr.delete(from, from + 9)).ok).toBe(true);
    expect(core.text).toBe('- a\n\n* b\n');
    expect(parseDocument(core.text, { trailingParagraph: false }).segments).toHaveLength(2);
  });
});

describe('undo and redo give the source back exactly', () => {
  it('after typing, a structural edit, marks and a block removal', () => {
    const original = '# Title\n\nHello _there_ &amp; world\n\n- a\n- b\n\n> q\n\nlast\n';
    const core = withHistory(original);
    const texts = [core.text];
    insert(core, 'XY', posOf(core, 'Hello', 2));
    texts.push(core.text);
    const word = posOf(core, 'world');
    select(core, word, word + 5);
    run(core, toggleMark(schema.marks['strong']!));
    texts.push(core.text);
    const last = posOf(core, 'last') - 1;
    expect(core.apply(core.state.tr.delete(last, last + 6)).ok).toBe(true);
    texts.push(core.text);
    for (let i = texts.length - 2; i >= 0; i -= 1) {
      run(core, undo);
      expect(core.text).toBe(texts[i]);
    }
    expect(core.text).toBe(original);
    for (let i = 1; i < texts.length; i += 1) {
      run(core, redo);
      expect(core.text).toBe(texts[i]);
    }
  });
});

describe('external replacement', () => {
  it('replaces everything with a fresh state: nothing of it is in the undo history', () => {
    const core = withHistory('one\n\ntwo\n');
    insert(core, 'X', posOf(core, 'one', 1));
    core.reset('server text\n\nmore\n');
    expect(core.text).toBe('server text\n\nmore\n');
    expect(() => run(core, undo)).toThrow();
    expect(core.text).toBe('server text\n\nmore\n');
  });
});

/** Positions inside editable text of a top-level block. */
function textPositions(doc: PMNode, index: number): number[] {
  let start = 0;
  for (let i = 0; i < index; i += 1) start += doc.child(i).nodeSize;
  const out: number[] = [];
  const top = doc.child(index);
  if (top.isTextblock) {
    for (let k = 0; k <= top.content.size; k += 1) out.push(start + 1 + k);
    return out;
  }
  top.descendants((node, pos) => {
    if (node.isTextblock)
      for (let k = 0; k <= node.content.size; k += 1) out.push(start + pos + 2 + k);
    return !node.isTextblock;
  });
  return out;
}

const meanings = (doc: PMNode): string[] => {
  const out: string[] = [];
  doc.forEach((node) => {
    if (node.type.name === 'paragraph' && node.content.size === 0) return;
    out.push(fingerprintString(node));
  });
  return out;
};

/** A textblock that starts or ends with a space: kept as typed, and dropped when the source is read again. */
const edgeSpace = (node: PMNode) => {
  let found = false;
  node.descendants((child) => {
    if (child.isTextblock && /^[ \t]|[ \t]$/.test(child.textContent)) found = true;
    return !child.isTextblock;
  });
  return found || (node.isTextblock && /^[ \t]|[ \t]$/.test(node.textContent));
};

const atoms = (node: PMNode) => {
  let count = 0;
  node.descendants((child) => {
    if (child.type.name === 'atom_inline') count += 1;
    return true;
  });
  return count;
};

const signature = (segment: ReturnType<typeof parseDocument>['segments'][number]) =>
  segment.tbs
    .map(
      (tb) =>
        `${tb.pm}:${tb.size}:${tb.s}-${tb.e}|` +
        tb.map.map((t) => `${t.kind[0]}${t.pm}+${t.len}@${t.s}-${t.e}`).join(','),
    )
    .join(' / ');

describe('random edits in random documents (property tests)', () => {
  it('only the edited block changes, and what the source says is what the editor shows', () => {
    let edits = 0;
    for (let seed = 1; seed <= 600; seed += 1) {
      const core = withHistory(randomDocument(seed));
      const next = rng(seed * 7919);
      const candidates: number[] = [];
      for (let i = 0; i < core.doc.childCount; i += 1) {
        if (core.doc.child(i).type.name !== 'atom_block' && textPositions(core.doc, i).length > 0) {
          candidates.push(i);
        }
      }
      if (candidates.length === 0) continue;
      const index = candidates[Math.floor(next() * candidates.length)]!;
      const positions = textPositions(core.doc, index);
      const pos = positions[Math.floor(next() * positions.length)]!;
      const before = core.text;
      const segments = core.model.segments;
      const start =
        segments.slice(0, index).reduce((n, s) => n + s.gap.length + s.src.length, 0) +
        segments[index]!.gap.length;
      const end = start + segments[index]!.src.length;

      const op = Math.floor(next() * 4);
      const $pos = core.doc.resolve(pos);
      let tr = core.state.tr;
      if (op === 0) tr = tr.insertText('ab', pos);
      else if (op === 1 && $pos.parent.isTextblock && pos > $pos.start())
        tr = tr.delete(pos - 1, pos);
      else if (
        op === 2 &&
        $pos.parent.isTextblock &&
        $pos.depth === 1 &&
        $pos.parent.type.name === 'paragraph'
      )
        tr = tr.split(pos);
      else tr = tr.insertText(' q', pos);
      const result = core.apply(tr);
      if (!result.ok)
        throw new Error(`seed ${seed} op ${op}: refused for ${JSON.stringify(before)}`);
      edits += 1;
      const after = result.text;
      expect(after.slice(0, start), `seed ${seed} prefix`).toBe(before.slice(0, start));
      expect(after.endsWith(before.slice(end)), `seed ${seed} suffix`).toBe(true);
      expect(core.model.text).toBe(core.model.join());
      const reparsed = new EditorCore(after);
      expect(meanings(reparsed.doc), `seed ${seed}: ${JSON.stringify(after)}`).toEqual(
        meanings(core.doc),
      );
      // The position maps the model keeps agree with the ones a fresh read of the source gives.
      // (An empty paragraph has no source and is not read back.)
      const fresh = reparsed.model.segments.filter((s) => s.src !== '');
      const mine = core.model.segments.filter((s) => s.src !== '');
      expect(mine.length).toBe(fresh.length);
      mine.forEach((segment, k) => {
        if (segment.node.type.name === 'atom_block') return;
        // Spaces at a line's edge are kept as typed and dropped (as gap) when the source is read again.
        if (edgeSpace(segment.node) || / \n/.test(segment.src)) return;
        // Text typed as $x$ or [@k] is literal until the block is read again (see reconcile).
        if (atoms(segment.node) !== atoms(fresh[k]!.node)) return;
        expect(signature(segment), `seed ${seed} segment ${k}`).toBe(signature(fresh[k]!));
      });
      // And undo gives the bytes back.
      expect(run(core, undo)?.ok).toBe(true);
      expect(core.text, `seed ${seed} undo`).toBe(before);
    }
    expect(edits).toBeGreaterThan(450);
  });
});
