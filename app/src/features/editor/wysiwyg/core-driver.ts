import { history } from 'prosemirror-history';
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection, type Plugin, type Transaction } from 'prosemirror-state';

import { EditorCore } from './core';
import { fingerprintString, isBlankParagraph } from './equivalence';
import { parseDocument } from './parse';
import { buildPlugins } from './plugins';

/**
 * A driver for tests that exercise the editor without a DOM: the real plugins (key bindings, input
 * rules), typing as ProseMirror does it (text-input rules first), keys through the keymap, and the
 * oracle the property tests share - the editor's blocks against a parse of the WHOLE resulting
 * source.
 */
export interface Driver {
  core: EditorCore;
  plugins: Plugin[];
}

export function makeDriver(text: string): Driver {
  const plugins = buildPlugins(
    { onFlush() {}, onEditInSource() {}, requestLink: () => 'https://x.example' },
    'placeholder',
  );
  // (Every edit is its own undo step.)
  plugins[1] = history({ newGroupDelay: -1 });
  return { core: new EditorCore(text, plugins), plugins };
}

/** Puts the selection at editor positions. */
export function setSelection(core: EditorCore, from: number, to = from) {
  const doc = core.doc;
  core.state = core.state.apply(
    core.state.tr.setSelection(TextSelection.between(doc.resolve(from), doc.resolve(to))),
  );
}

/** Editor position of source offset `offset` (the start of the text there). */
export function atSource(core: EditorCore, offset: number): number {
  return core.model.srcToPos(offset, 'start');
}

type Applied = ReturnType<EditorCore['apply']>;

/** Types `text` one character at a time, as the editor does; returns each result. */
export function typeText(driver: Driver, text: string): Applied[] {
  const results: Applied[] = [];
  const { core, plugins } = driver;
  for (const char of Array.from(text)) {
    let result: Applied | null = null;
    const view = {
      get state() {
        return core.state;
      },
      dispatch: (tr: Transaction) => {
        result = core.apply(tr);
      },
      composing: false,
    };
    const { from, to } = core.state.selection;
    const deflt = () => core.state.tr.insertText(char, from, to).scrollIntoView();
    let handled = false;
    for (const plugin of plugins) {
      const handler = plugin.props.handleTextInput;
      if (handler && handler.call(plugin, view as never, from, to, char, deflt)) {
        handled = true;
        break;
      }
    }
    if (!handled) result = core.apply(deflt());
    results.push(result as unknown as Applied);
  }
  return results;
}

/** A key through the plugins' key handlers; the result of the transaction it made, if any. */
export function pressKey(
  driver: Driver,
  key: string,
  modifiers: { shift?: boolean; ctrl?: boolean } = {},
): { handled: boolean; result: Applied | null } {
  const { core, plugins } = driver;
  let result: Applied | null = null;
  const view = {
    get state() {
      return core.state;
    },
    dispatch: (tr: Transaction) => {
      result = core.apply(tr);
    },
    composing: false,
    endOfTextblock: () => true,
    isDestroyed: false,
    focus() {},
  };
  const event = {
    key,
    shiftKey: !!modifiers.shift,
    ctrlKey: !!modifiers.ctrl,
    metaKey: false,
    altKey: false,
    keyCode: 0,
  } as KeyboardEvent;
  let handled = false;
  for (const plugin of plugins) {
    const handler = plugin.props.handleKeyDown;
    if (handler && handler.call(plugin, view as never, event)) {
      handled = true;
      break;
    }
  }
  return { handled, result };
}

/** The blocks of a document as meanings (blank paragraphs are nothing). */
export function meanings(doc: PMNode): string[] {
  const out: string[] = [];
  doc.forEach((node) => {
    if (!isBlankParagraph(node)) out.push(fingerprintString(node));
  });
  return out;
}

/** The oracle: what an independent parse of the whole source says the blocks are. */
export function meaningsOfSource(text: string): string[] {
  return parseDocument(text, { trailingParagraph: false })
    .segments.filter((segment) => segment.src !== '')
    .map((segment) => fingerprintString(segment.node));
}

/** Whether the editor's blocks and the whole source agree (what every test of an edit asserts). */
export function agrees(core: EditorCore): boolean {
  return JSON.stringify(meanings(core.doc)) === JSON.stringify(meaningsOfSource(core.text));
}

/** A compact dump of a document for failure messages. */
export function dump(node: PMNode): string {
  if (node.isText) {
    const marks = node.marks.map((mark) => mark.type.name).join(',');
    return JSON.stringify(node.text) + (marks ? `{${marks}}` : '');
  }
  const name = node.type.name;
  if (name === 'atom_inline' || name === 'atom_block') {
    return `<${name}:${node.attrs['kind'] as string}:${JSON.stringify(node.attrs['source'])}>`;
  }
  const kids: string[] = [];
  node.forEach((child) => {
    if (!isBlankParagraph(child)) kids.push(dump(child));
  });
  return `${name}(${kids.join(' ')})`;
}
