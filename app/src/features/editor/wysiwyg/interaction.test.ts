import { NodeSelection, TextSelection } from 'prosemirror-state';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleBeforeInput, keepReactOutOfTheEditor } from './controller';
import { lastChange, mount, posOf, press, select, type, type Harness } from './test-harness';

let harness: Harness | null = null;
afterEach(() => {
  harness?.destroy();
  harness = null;
});

const open = (text: string, overrides = {}) => {
  harness = mount(text, overrides);
  return harness;
};

const countCalls = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls.length;

describe('leaving and coming back change nothing', () => {
  it('undo works across a blur: text typed as a formula and a citation is undone step by step', () => {
    const h = open('Hello\n');
    select(h.view, posOf(h.view, 'Hello', 5));
    type(h.view, ' is $x$ ok');
    expect(h.controller.core.text).toBe('Hello is $x$ ok\n');
    h.view.dom.dispatchEvent(new FocusEvent('blur'));
    h.view.dom.dispatchEvent(new FocusEvent('focus'));
    // Everything typed goes away with Ctrl+Z, however often the editor was left meanwhile.
    for (let i = 0; i < 40 && h.controller.core.text !== 'Hello\n'; i += 1) {
      press(h.view, 'z', { ctrl: true });
    }
    expect(h.controller.core.text).toBe('Hello\n');
    expect(lastChange(h.props)).toBe('Hello\n');
  });

  it('opening, focus, caret moves and blur change neither the document nor the source, and report nothing', () => {
    const text = '   leading spaces\n\nTyped $x$ and  [@k]  \n\n- [ ] task\n';
    const h = open(text);
    const doc = h.view.state.doc;
    const model = h.controller.core.model.segments;
    h.view.dom.dispatchEvent(new FocusEvent('focus'));
    select(h.view, posOf(h.view, 'Typed', 2));
    h.view.dom.dispatchEvent(new FocusEvent('blur'));
    h.view.dom.dispatchEvent(new FocusEvent('focus'));
    select(h.view, posOf(h.view, 'leading', 3), posOf(h.view, 'leading', 6));
    h.view.dom.dispatchEvent(new FocusEvent('blur'));
    expect(h.view.state.doc).toBe(doc);
    expect(h.controller.core.model.segments).toEqual(model);
    expect(h.controller.core.text).toBe(text);
    expect(countCalls(h.props.onChange)).toBe(0);
  });

  it('text typed as $x$ stays literal (and the document the editor shows stays the same) through any number of blurs', () => {
    const h = open('Hello\n');
    select(h.view, 6);
    type(h.view, ' $y$');
    const doc = h.view.state.doc;
    const calls = countCalls(h.props.onChange);
    for (let i = 0; i < 3; i += 1) h.view.dom.dispatchEvent(new FocusEvent('blur'));
    expect(h.view.state.doc).toBe(doc);
    expect(countCalls(h.props.onChange)).toBe(calls);
    expect(h.view.dom.querySelector('[data-md-atom-inline]')).toBeNull();
  });
});

describe('typing and deleting from beforeinput (no reading the DOM back)', () => {
  const input = (type: string, data: string | null) =>
    new InputEvent('beforeinput', { inputType: type, data, bubbles: true, cancelable: true });

  it('inserts typed text at the selection and cancels the browser edit', () => {
    const h = open('Hello world\n');
    select(h.view, posOf(h.view, 'Hello', 5));
    const event = input('insertText', '!');
    expect(handleBeforeInput(h.view, event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(h.controller.core.text).toBe('Hello! world\n');
    expect(h.view.state.selection.from).toBe(posOf(h.view, 'Hello', 6));
  });

  it('runs the input rules (a typed "# " becomes a heading)', () => {
    const h = open('x\n');
    select(h.view, 1);
    handleBeforeInput(h.view, input('insertText', '#'));
    handleBeforeInput(h.view, input('insertText', ' '));
    expect(h.view.state.doc.firstChild!.type.name).toBe('heading');
  });

  it('deletes the reported range, a word or a selection, in one step', () => {
    const h = open('Hello world\n');
    select(h.view, posOf(h.view, 'Hello', 0), posOf(h.view, 'Hello', 6));
    const event = input('deleteContentBackward', null);
    expect(handleBeforeInput(h.view, event)).toBe(true);
    expect(h.controller.core.text).toBe('world\n');
  });

  it('leaves composition, newlines, other input types and a caret that deletes nothing to ProseMirror', () => {
    const h = open('Hello\n');
    select(h.view, 3);
    expect(handleBeforeInput(h.view, input('insertCompositionText', 'x'))).toBe(false);
    expect(handleBeforeInput(h.view, input('insertText', 'a\nb'))).toBe(false);
    expect(handleBeforeInput(h.view, input('insertFromPaste', 'x'))).toBe(false);
    expect(handleBeforeInput(h.view, input('deleteContentBackward', null))).toBe(false);
    expect(h.controller.core.text).toBe('Hello\n');
  });

  it('is what the real view runs for a beforeinput event', () => {
    const h = open('Hello\n');
    select(h.view, 6);
    const event = input('insertText', '?');
    h.view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(h.controller.core.text).toBe('Hello?\n');
  });
});

describe('the keyboard and the pointer', () => {
  it('Escape frees only the next Tab', () => {
    const h = open('- one\n- two\n');
    select(h.view, posOf(h.view, 'two', 1));
    press(h.view, 'Escape');
    expect(press(h.view, 'Tab')).toBe(false);
    // No other key in between: the Tab after the freed one indents again.
    expect(press(h.view, 'Tab')).toBe(true);
    expect(h.controller.core.text).toBe('- one\n  - two\n');
  });

  it('Space on a selected citation opens its source; Enter edits it in Source', () => {
    const onCitationClick = vi.fn();
    const h = open('See [@k1] here\n', {
      citations: [{ id: 'k1', sourceDoc: 'Doc', relevanceScore: 1 }],
      onCitationClick,
    });
    h.controller.host.onCitationClick = onCitationClick;
    let pos = -1;
    h.view.state.doc.descendants((node, at) => {
      if (pos < 0 && node.type.name === 'atom_inline') pos = at;
      return pos < 0;
    });
    h.view.dispatch(h.view.state.tr.setSelection(NodeSelection.create(h.view.state.doc, pos)));
    expect(press(h.view, ' ')).toBe(true);
    expect(onCitationClick).toHaveBeenCalledWith('k1');
    // Space on anything else is just a space.
    select(h.view, posOf(h.view, 'See', 0));
    expect(h.view.state.selection).toBeInstanceOf(TextSelection);
    expect(press(h.view, ' ')).toBe(false);
  });

  it('names a footnote text as a footnote text, not as a reference', () => {
    const h = open('Text[^1]\n\n[^1]: The note.\n');
    const [reference, text] = [
      h.view.dom.querySelector('[data-md-atom-inline][data-md-kind="footnote"]')!,
      h.view.dom.querySelector('[data-md-atom-block][data-md-kind="footnote"]')!,
    ];
    expect(reference.getAttribute('aria-label')).toContain('Footnote reference');
    expect(text.getAttribute('aria-label')).toContain('Footnote text');
    expect(text.getAttribute('aria-label')).not.toContain('reference');
  });

  it('tells citations apart for the keyboard: the label says how to open the source', () => {
    const h = open('See [@k1]\n');
    const chip = h.view.dom.querySelector('[data-md-kind="citation"]')!;
    expect(chip.getAttribute('aria-label')).toContain('Space to open its source');
  });

  it('ignores files dropped on it: no insertion, and the browser does not open them', () => {
    const h = open('Hello\n');
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: { files: [new File(['x'], 'x.png', { type: 'image/png' })], types: ['Files'] },
    });
    h.view.dom.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(h.controller.core.text).toBe('Hello\n');
    expect(h.view.dom.querySelector('img')).toBeNull();
  });

  it('keeps grammar and translation helpers out of the text, but lets the page be translated', () => {
    const h = open('Hello\n');
    const { dom } = h.view;
    expect(dom.getAttribute('data-gramm')).toBe('false');
    expect(dom.getAttribute('data-gramm_editor')).toBe('false');
    expect(dom.getAttribute('data-enable-grammarly')).toBe('false');
    expect(dom.getAttribute('translate')).toBe('yes');
  });
});

describe('keeping React out of the editor', () => {
  it('shadows contentEditable on the editor element only, and leaves the attribute alone', () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'contentEditable');
    // (jsdom has no contentEditable property; a browser has an accessor that reads "true".)
    Object.defineProperty(HTMLElement.prototype, 'contentEditable', {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute('contenteditable') ?? 'inherit';
      },
      set(this: HTMLElement, value: string) {
        this.setAttribute('contenteditable', value);
      },
    });
    try {
      const editor = document.createElement('div');
      editor.setAttribute('contenteditable', 'true');
      const other = document.createElement('div');
      other.setAttribute('contenteditable', 'true');
      expect(keepReactOutOfTheEditor(editor)).toBe(true);
      expect(editor.contentEditable).not.toBe('true');
      expect(editor.getAttribute('contenteditable')).toBe('true');
      expect(other.contentEditable).toBe('true');
      editor.contentEditable = 'false';
      expect(editor.getAttribute('contenteditable')).toBe('false');
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'contentEditable', original);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)['contentEditable'];
    }
  });

  it('is skipped (not the editor) where the property cannot be shadowed', () => {
    const frozen = Object.freeze(document.createElement('div'));
    // A probe cannot be built the way the real element would be shadowed: the editor goes without.
    const doc = {
      createElement: () => frozen,
    } as unknown as Document;
    const el = { ownerDocument: doc } as unknown as HTMLElement;
    expect(keepReactOutOfTheEditor(el)).toBe(false);
  });
});
