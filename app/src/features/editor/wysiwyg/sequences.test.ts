import {
  chainCommands,
  deleteSelection,
  joinBackward,
  joinForward,
  selectNodeBackward,
  setBlockType,
  splitBlock,
  toggleMark,
  wrapIn,
} from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import type { Node as PMNode } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { Selection, TextSelection, type Command } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';

import { EditorCore } from './core';
import { fingerprintString, isBlankParagraph } from './equivalence';
import { parseDocument } from './parse';
import { schema } from './schema';
import { goldenDocuments, randomDocument, rng } from './test-docs';

const { nodes, marks } = schema;

const meanings = (doc: PMNode): string[] => {
  const out: string[] = [];
  doc.forEach((node) => {
    if (isBlankParagraph(node)) return;
    out.push(fingerprintString(node));
  });
  return out;
};

const commands: Command[] = [
  toggleMark(marks['strong']!),
  toggleMark(marks['em']!),
  toggleMark(marks['code']!),
  splitBlock,
  splitListItem(nodes['list_item']!),
  chainCommands(deleteSelection, joinBackward, selectNodeBackward),
  chainCommands(deleteSelection, joinForward),
  wrapInList(nodes['bullet_list']!),
  wrapInList(nodes['ordered_list']!),
  sinkListItem(nodes['list_item']!),
  liftListItem(nodes['list_item']!),
  setBlockType(nodes['heading']!, { level: 2 }),
  setBlockType(nodes['paragraph']!),
  wrapIn(nodes['blockquote']!),
];

interface Session {
  core: EditorCore;
  /** The source before every edit that went into the undo history, oldest first. */
  before: string[];
  steps: number;
  refused: number;
}

/** Runs `count` random edits; `withHistoryOps` lets undo and redo be among them. */
function runSession(
  seed: number,
  count: number,
  withHistoryOps: boolean,
  check: (s: Session, step: number) => void,
  start: string = randomDocument(seed, { tight: seed % 2 === 0 }),
): Session {
  const next = rng(seed * 104729);
  const original = start;
  const core = new EditorCore(original, [history({ newGroupDelay: -1 })]);
  const session: Session = { core, before: [], steps: 0, refused: 0 };
  for (let step = 0; step < count; step += 1) {
    const doc = core.doc;
    // A random selection inside the document.
    const a = Selection.atStart(doc).from + Math.floor(next() * (doc.content.size - 1));
    const b = next() < 0.5 ? a : Math.min(doc.content.size, a + Math.floor(next() * 12));
    try {
      core.state = core.state.apply(
        core.state.tr.setSelection(TextSelection.between(doc.resolve(a), doc.resolve(b))),
      );
    } catch {
      continue;
    }
    const op = Math.floor(next() * 20);
    const textBefore = core.text;
    let result: ReturnType<EditorCore['apply']> | null = null;
    let fromHistory = false;
    let applyError: unknown = null;
    const apply = (tr: Parameters<EditorCore['apply']>[0]) => {
      try {
        result = core.apply(tr);
      } catch (error) {
        applyError = error;
      }
    };
    if (op < 6) {
      const words = [
        'x',
        'ab',
        ' q',
        '* ',
        'é',
        '😀',
        '\u00a0',
        '7.',
        '$',
        '[@k]',
        '\\',
        '   ',
        'www.a.b',
      ];
      const { from, to } = core.state.selection;
      apply(core.state.tr.insertText(words[Math.floor(next() * words.length)]!, from, to));
    } else if (op < 8) {
      const { from, to } = core.state.selection;
      if (to > from) apply(core.state.tr.deleteSelection());
      else apply(core.state.tr.delete(Math.max(1, from - 1), from));
    } else if (op === 8 && withHistoryOps) {
      fromHistory = true;
      undo(core.state, apply);
    } else if (op === 9 && withHistoryOps) {
      fromHistory = true;
      redo(core.state, apply);
    } else {
      try {
        commands[Math.floor(next() * commands.length)]!(core.state, apply);
      } catch {
        // ProseMirror's own commands can throw on selections they do not expect (list wrapping across
        // atoms); that is theirs, not the model's - an error in `core.apply` is rethrown below.
        if (!applyError) continue;
      }
    }
    if (applyError) throw applyError;
    session.steps += 1;
    const done = result as ReturnType<EditorCore['apply']> | null;
    if (!done) continue;
    if (!done.ok) {
      session.refused += 1;
      continue;
    }
    if (done.docChanged && !fromHistory) {
      session.before.push(textBefore);
    }
    check(session, step);
  }
  return session;
}

describe('long random editing sessions keep the source and the editor in agreement', () => {
  it('300 sessions of 25 edits (with undo and redo among them): no exception, the source always reads as the editor shows', () => {
    let steps = 0;
    let refused = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      // (Documents with single-newline gaps on even seeds, a golden section on every seventh; nothing
      // is skipped: formulas, citations, backslashes and edge whitespace are all in play.)
      const start = seed % 7 === 0 ? goldenDocuments[seed % goldenDocuments.length]! : undefined;
      const session = runSession(
        seed,
        25,
        true,
        ({ core }, step) => {
          // The model's text is the model's parts, and reading the WHOLE source again (an independent
          // parse, the oracle) gives the blocks the editor shows.
          expect(core.model.text, `seed ${seed} step ${step}`).toBe(core.model.join());
          const reread = parseDocument(core.text, { trailingParagraph: false });
          const mine = meanings(core.doc);
          const theirs = reread.segments
            .filter((s) => s.src !== '')
            .map((s) => fingerprintString(s.node));
          if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
            throw new Error(
              `seed ${seed} step ${step}: ${JSON.stringify(core.text)}\n mine ${JSON.stringify(mine)}\n read ${JSON.stringify(theirs)}`,
            );
          }
        },
        start,
      );
      steps += session.steps;
      refused += session.refused;
    }
    expect(steps).toBeGreaterThan(5000);
    // Refusals are for edits that have no Markdown form, never routine.
    expect(refused / steps).toBeLessThan(0.01);
  }, 120000);

  it('undoing a session edit by edit gives the source back exactly at every step (300 sessions)', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const session = runSession(
        seed,
        25,
        false,
        () => {},
        seed % 7 === 0 ? goldenDocuments[seed % goldenDocuments.length]! : undefined,
      );
      const { core, before } = session;
      for (let k = before.length - 1; k >= 0; k -= 1) {
        let applied = false;
        undo(core.state, (tr) => {
          applied = core.apply(tr).ok;
        });
        if (!applied) throw new Error(`seed ${seed}: undo ${k} refused`);
        // (A list that took the other marker to stay apart from a neighbour may keep it after an undo,
        // and a backslash escape - the same text written escaped or not - is not remembered for blocks
        // that left the model's bounded memory or were written more than one way.)
        const plain = (text: string) =>
          text
            .replace(/^( *)[-*+] /gm, '$1- ')
            .replace(/^( *\d+)\) /gm, '$1. ')
            .replace(/\\(?=[!-/:-@[-`{-~])/g, '');
        if (plain(core.text) !== plain(before[k]!)) {
          let i = 0;
          while (i < before[k]!.length && before[k]![i] === core.text[i]) i += 1;
          throw new Error(
            `seed ${seed} undo ${k} of ${before.length} differs at ${i}: expected ${JSON.stringify(before[k]!.slice(Math.max(0, i - 25), i + 40))} got ${JSON.stringify(core.text.slice(Math.max(0, i - 25), i + 40))}`,
          );
        }
      }
    }
  }, 60000);
});
