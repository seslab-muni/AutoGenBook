import { NodeSelection } from 'prosemirror-state';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { markdownSlice, parseClipboardText, pasteBlocks, sliceToMarkdown } from './clipboard';
import { lastChange, mount, posOf, press, select, type, type Harness } from './test-harness';
import { schema } from './schema';

let harness: Harness | null = null;
afterEach(() => {
  vi.unstubAllGlobals();
  harness?.destroy();
  harness = null;
});

const open = (text: string, overrides = {}) => {
  harness = mount(text, overrides);
  return harness;
};

describe('opening a section', () => {
  it('never reports a change: open, focus, move the caret, blur', () => {
    const h = open('# Title\n\nHello _there_ &amp; $x$\n\n| a |\n| - |\n| 1 |\n');
    select(h.view, posOf(h.view, 'Hello', 2));
    select(h.view, posOf(h.view, 'Hello', 4), posOf(h.view, 'Hello', 5));
    h.view.dom.dispatchEvent(new FocusEvent('blur'));
    expect(h.props.onChange).not.toHaveBeenCalled();
    expect(h.controller.core.text).toBe(
      '# Title\n\nHello _there_ &amp; $x$\n\n| a |\n| - |\n| 1 |\n',
    );
  });

  it('publishes the caret as source offsets once mounted, and again when it moves', async () => {
    const h = open('ab\n\ncd\n');
    await vi.waitFor(() => expect(h.props.onSelectionChange).toHaveBeenCalled());
    select(h.view, posOf(h.view, 'cd', 1));
    await vi.waitFor(() => {
      const calls = (h.props.onSelectionChange as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.at(-1)?.[0]).toMatchObject({ from: 5, to: 5, line: 3, column: 2 });
    });
  });

  it('labels the editable region as a multiline textbox', () => {
    const h = open('x\n');
    expect(h.view.dom).toHaveAttribute('role', 'textbox');
    expect(h.view.dom).toHaveAttribute('aria-multiline', 'true');
    expect(h.view.dom).toHaveAttribute('aria-label', 'Section text');
    expect(h.view.dom).toHaveAttribute('data-markdown-root');
  });

  it('shows a placeholder only while the section is empty', () => {
    const h = open('');
    expect(h.view.dom.querySelector('.md-placeholder')).not.toBeNull();
    type(h.view, 'a');
    expect(h.view.dom.querySelector('.md-placeholder')).toBeNull();
  });
});

describe('typing', () => {
  it('hands the new source to onChange after every edit, with only that block changed', () => {
    const h = open('one\n\ntwo\n\nthree\n');
    select(h.view, posOf(h.view, 'two', 3));
    type(h.view, '!');
    expect(lastChange(h.props)).toBe('one\n\ntwo!\n\nthree\n');
    type(h.view, '?');
    expect(lastChange(h.props)).toBe('one\n\ntwo!?\n\nthree\n');
    expect(h.props.onChange).toHaveBeenCalledTimes(2);
  });

  it('does not call onChange for an edit that leaves the source as it was (Enter at the end of a block)', () => {
    const h = open('one\n\ntwo\n');
    select(h.view, posOf(h.view, 'one', 3));
    press(h.view, 'Enter');
    expect(h.props.onChange).not.toHaveBeenCalled();
  });

  it('refuses what cannot be written as Markdown, tells the owner, and keeps the document', () => {
    const h = open('ab`cd`\n');
    // Emphasis around code that touches a letter has no Markdown form.
    const from = posOf(h.view, 'cd', 0);
    h.view.dispatch(h.view.state.tr.addMark(from, from + 2, schema.marks['em']!.create()));
    expect(h.props.onRefused).toHaveBeenCalledTimes(1);
    expect(h.controller.core.text).toBe('ab`cd`\n');
    expect(h.view.state.doc.firstChild!.textContent).toBe('abcd');
  });

  it('does not take edits while read-only', () => {
    const h = open('Hello\n', { readOnly: true });
    expect(h.view.editable).toBe(false);
    expect(h.view.dom).toHaveAttribute('aria-readonly', 'true');
  });

  it('flushes on Ctrl+S and on blur', () => {
    const h = open('x\n');
    press(h.view, 's', { ctrl: true });
    expect(h.props.onFlush).toHaveBeenCalledTimes(1);
    h.view.dom.dispatchEvent(new FocusEvent('blur'));
    expect(h.props.onFlush).toHaveBeenCalledTimes(2);
  });
});

describe('text typed as formulas and citations', () => {
  it('stays literal until the section is read again: leaving the editor changes nothing', () => {
    const h = open('Hello world\n');
    select(h.view, posOf(h.view, 'world', 5));
    type(h.view, ' $y^2$ and [@k1]');
    const typed = h.controller.core.text;
    expect(typed).toBe('Hello world $y^2$ and [@k1]\n');
    const doc = h.view.state.doc;
    const calls = (h.props.onChange as ReturnType<typeof vi.fn>).mock.calls.length;
    h.view.dom.dispatchEvent(new FocusEvent('blur'));
    h.view.dom.dispatchEvent(new FocusEvent('blur'));
    // Nothing changed: not the document, not the source, nothing was reported.
    expect(h.view.state.doc).toBe(doc);
    expect(h.view.dom.querySelector('[data-md-atom-inline]')).toBeNull();
    expect(h.controller.core.text).toBe(typed);
    expect((h.props.onChange as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  });
});

describe('Markdown input rules and shortcuts', () => {
  it('turns "## " into a heading, "- " into a list, "1. " into a numbered list, "> " into a quote', () => {
    const h = open('x\n');
    select(h.view, 2);
    press(h.view, 'Enter');
    type(h.view, '## Head');
    expect(h.view.state.doc.child(1).type.name).toBe('heading');
    expect(h.view.state.doc.child(1).attrs['level']).toBe(2);
    expect(h.controller.core.text).toBe('x\n\n## Head\n');
    press(h.view, 'Enter');
    type(h.view, '- item');
    expect(h.controller.core.text).toBe('x\n\n## Head\n\n- item\n');
    press(h.view, 'Enter');
    press(h.view, 'Enter');
    type(h.view, '1. first');
    expect(h.controller.core.text).toBe('x\n\n## Head\n\n- item\n\n1. first\n');
    press(h.view, 'Enter');
    press(h.view, 'Enter');
    type(h.view, '> quoted');
    expect(h.controller.core.text).toBe('x\n\n## Head\n\n- item\n\n1. first\n\n> quoted\n');
  });

  it('turns ```py + space into a code block', () => {
    const h = open('x\n');
    select(h.view, 2);
    press(h.view, 'Enter');
    type(h.view, '```py ');
    type(h.view, 'a = 1');
    expect(h.controller.core.text).toBe('x\n\n```py\na = 1\n```\n');
  });

  it('turns **bold**, *em*, _em_ and `code` typed out into marks, written as the document writes them', () => {
    const h = open('start\n');
    select(h.view, posOf(h.view, 'start', 5));
    type(h.view, ' **b** and *e* and `c` and _u_ end');
    expect(h.controller.core.text).toBe('start **b** and *e* and `c` and *u* end\n');
    expect(h.view.dom.querySelectorAll('strong')).toHaveLength(1);
    expect(h.view.dom.querySelectorAll('em')).toHaveLength(2);
    expect(h.view.dom.querySelectorAll('code')).toHaveLength(1);
  });

  it('writes emphasis with underscores in a document that uses them', () => {
    const h = open('a _b_ and c\n');
    select(h.view, posOf(h.view, 'c', 1));
    type(h.view, ' *x*');
    expect(h.controller.core.text).toBe('a _b_ and c _x_\n');
  });

  it('Ctrl+B, Ctrl+I and Ctrl+E mark the selection, and again unmark it', () => {
    const h = open('plain word here\n');
    const from = posOf(h.view, 'word');
    select(h.view, from, from + 4);
    press(h.view, 'b', { ctrl: true });
    expect(h.controller.core.text).toBe('plain **word** here\n');
    press(h.view, 'i', { ctrl: true });
    expect(h.controller.core.text).toBe('plain ***word*** here\n');
    press(h.view, 'b', { ctrl: true });
    press(h.view, 'i', { ctrl: true });
    press(h.view, 'e', { ctrl: true });
    expect(h.controller.core.text).toBe('plain `word` here\n');
  });

  it('Ctrl+K links the selection to what the owner answers, and removes it on an empty answer', async () => {
    const answers = ['https://linked.example', ''];
    const requestLink = vi.fn(async () => answers.shift() ?? null);
    const h = open('see the docs please\n', { requestLink });
    const from = posOf(h.view, 'docs');
    select(h.view, from, from + 4);
    press(h.view, 'k', { ctrl: true });
    await vi.waitFor(() =>
      expect(h.controller.core.text).toBe('see the [docs](https://linked.example) please\n'),
    );
    press(h.view, 'k', { ctrl: true });
    await vi.waitFor(() => expect(h.controller.core.text).toBe('see the docs please\n'));
  });

  it('Shift+Enter is a hard break, in the document style', () => {
    const h = open('one  \ntwo\n');
    select(h.view, posOf(h.view, 'two', 3));
    press(h.view, 'Enter', { shift: true });
    type(h.view, 'x');
    expect(h.controller.core.text).toBe('one  \ntwo  \nx\n');
  });

  it('Enter splits a list item, and Enter on an empty item leaves the list', () => {
    const h = open('- one\n- two\n');
    select(h.view, posOf(h.view, 'two', 3));
    press(h.view, 'Enter');
    type(h.view, 'three');
    expect(h.controller.core.text).toBe('- one\n- two\n- three\n');
    press(h.view, 'Enter');
    press(h.view, 'Enter');
    type(h.view, 'after');
    expect(h.controller.core.text).toBe('- one\n- two\n- three\n\nafter\n');
  });

  it('Backspace at the start of a paragraph joins it to the one before, Delete the other way', () => {
    const h = open('one\n\ntwo\n\nthree\n');
    select(h.view, posOf(h.view, 'two'));
    press(h.view, 'Backspace');
    expect(h.controller.core.text).toBe('onetwo\n\nthree\n');
    select(h.view, posOf(h.view, 'onetwo', 6));
    press(h.view, 'Delete');
    expect(h.controller.core.text).toBe('onetwothree\n');
  });

  it('Backspace right after an input rule undoes the rule', () => {
    const h = open('x\n');
    select(h.view, 2);
    press(h.view, 'Enter');
    type(h.view, '## ');
    expect(h.view.state.doc.child(1).type.name).toBe('heading');
    press(h.view, 'Backspace');
    expect(h.view.state.doc.child(1).type.name).toBe('paragraph');
    expect(h.view.state.doc.child(1).textContent).toBe('## ');
  });

  it('Ctrl+Z and Ctrl+Y undo and redo, and give the exact source back', () => {
    const h = open('Hello _there_ &amp; world\n');
    const before = h.controller.core.text;
    select(h.view, posOf(h.view, 'Hello', 2));
    type(h.view, 'XY');
    const typed = h.controller.core.text;
    press(h.view, 'z', { ctrl: true });
    expect(h.controller.core.text).toBe(before);
    press(h.view, 'y', { ctrl: true });
    expect(h.controller.core.text).toBe(typed);
  });
});

describe('Tab', () => {
  it('indents a list item and outdents with Shift+Tab', () => {
    const h = open('- one\n- two\n');
    select(h.view, posOf(h.view, 'two', 1));
    expect(press(h.view, 'Tab')).toBe(true);
    expect(h.controller.core.text).toBe('- one\n  - two\n');
    expect(press(h.view, 'Tab', { shift: true })).toBe(true);
    expect(h.controller.core.text).toBe('- one\n- two\n');
  });

  it('is left to the browser outside a list, so keyboard users are never trapped', () => {
    const h = open('plain paragraph\n');
    select(h.view, 3);
    expect(press(h.view, 'Tab')).toBe(false);
    expect(press(h.view, 'Tab', { shift: true })).toBe(false);
  });

  it('Escape, then Tab inside a list, lets focus leave', () => {
    const h = open('- one\n- two\n');
    select(h.view, posOf(h.view, 'two', 1));
    press(h.view, 'Escape');
    expect(press(h.view, 'Tab')).toBe(false);
    expect(h.controller.core.text).toBe('- one\n- two\n');
    // The escape applies once: the next Tab indents again.
    press(h.view, 'a');
    expect(press(h.view, 'Tab')).toBe(true);
  });
});

describe('atoms', () => {
  const doc = 'Text $x^2$ and [@k]\n\n| a |\n| - |\n| 1 |\n\n> **Theorem 1** Statement.\n';

  it('shows math, citations, tables and callouts as atoms with their exact source', () => {
    const h = open(doc);
    const inline = [...h.view.dom.querySelectorAll('[data-md-atom-inline]')];
    expect(inline.map((el) => el.getAttribute('data-md-kind'))).toEqual(['math', 'citation']);
    const blocks = [...h.view.dom.querySelectorAll('[data-md-atom-block]')];
    expect(blocks.map((el) => el.getAttribute('data-md-kind'))).toEqual(['table', 'callout']);
    expect(inline.every((el) => el.getAttribute('contenteditable') === 'false')).toBe(true);
    expect(h.controller.core.text).toBe(doc);
  });

  it('names each atom and says how to edit it, as an image role (nothing inside is a tab stop)', () => {
    const h = open(doc);
    const math = h.view.dom.querySelector('[data-md-kind="math"]')!;
    expect(math).toHaveAttribute('role', 'img');
    expect(math.getAttribute('aria-label')).toBe('Formula: x^2. Press Enter to edit in Source.');
    expect(h.view.dom.querySelector('[tabindex]')).toBeNull();
    expect(h.view.dom.querySelector('button, a[href], input')).toBeNull();
  });

  it('Enter on a selected atom opens Source on its range; so does a double click and the label', () => {
    const h = open(doc);
    let mathPos = -1;
    h.view.state.doc.descendants((node, pos) => {
      if (mathPos < 0 && node.type.name === 'atom_inline') mathPos = pos;
      return mathPos < 0;
    });
    h.view.dispatch(h.view.state.tr.setSelection(NodeSelection.create(h.view.state.doc, mathPos)));
    expect(press(h.view, 'Enter')).toBe(true);
    const from = doc.indexOf('$x^2$');
    expect(h.props.onEditInSource).toHaveBeenLastCalledWith({ from, to: from + 5 });
    // The document is untouched by asking.
    expect(h.controller.core.text).toBe(doc);

    h.view.dom
      .querySelector('[data-md-kind="citation"]')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    const cite = doc.indexOf('[@k]');
    expect(h.props.onEditInSource).toHaveBeenLastCalledWith({ from: cite, to: cite + 4 });

    h.view.dom
      .querySelector('[data-md-kind="table"] .md-atom-hint')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const table = doc.indexOf('| a |');
    expect(h.props.onEditInSource).toHaveBeenLastCalledWith({
      from: table,
      to: doc.indexOf('| 1 |') + 5,
    });
  });

  it('cannot be typed into: arrow keys move over an atom as one character', () => {
    const h = open('a $x$ b\n');
    expect(h.view.state.doc.child(0).content.size).toBe(5);
    const atom = h.view.dom.querySelector('[data-md-atom-inline]')!;
    expect(atom.getAttribute('contenteditable')).toBe('false');
  });
});

describe('external replacement', () => {
  it("adopts a new value that is not the editor's own, without calling onChange or entering the undo history", () => {
    const h = open('one\n\ntwo\n');
    select(h.view, posOf(h.view, 'one', 3));
    type(h.view, 'X');
    expect(lastChange(h.props)).toBe('oneX\n\ntwo\n');
    const calls = (h.props.onChange as ReturnType<typeof vi.fn>).mock.calls.length;
    h.controller.setProps({ ...h.props, value: 'server one\n\nserver two\n' });
    expect(h.controller.core.text).toBe('server one\n\nserver two\n');
    expect(h.view.dom.textContent).toContain('server one');
    expect((h.props.onChange as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
    press(h.view, 'z', { ctrl: true });
    expect(h.controller.core.text).toBe('server one\n\nserver two\n');
  });

  it('does not mistake its own text coming back late for an outside change', () => {
    const h = open('a\n');
    select(h.view, 2);
    type(h.view, 'b');
    const first = lastChange(h.props)!;
    type(h.view, 'c');
    // The owner re-renders with the first text while the second is already in the editor.
    h.controller.setProps({ ...h.props, value: first });
    expect(h.controller.core.text).toBe('abc\n');
  });
});

describe('clipboard', () => {
  it('reads pasted plain text as Markdown', () => {
    const h = open('start\n');
    select(h.view, posOf(h.view, 'start', 5));
    const slice = parseClipboardText(' **bold** and `c`', h.view.state.doc.resolve(6), false);
    h.view.dispatch(h.view.state.tr.replaceSelection(slice));
    expect(h.controller.core.text).toBe('start **bold** and `c`\n');
  });

  it('keeps the spaces at the edges of a pasted fragment', () => {
    const slice = markdownSlice(' tail ');
    expect(slice.content.textBetween(0, slice.content.size)).toBe(' tail ');
  });

  it('puts pasted blocks between the text around the caret', () => {
    const h = open('Hello world\n');
    select(h.view, posOf(h.view, 'Hello', 5));
    expect(pasteBlocks(h.view, markdownSlice('\n\n## Pasted\n\n- a\n- b\n\nlast'))).toBe(true);
    expect(h.controller.core.text).toBe('Hello\n\n## Pasted\n\n- a\n- b\n\nlast\n\nworld\n');
  });

  it('pastes plain text into a code block as it is', () => {
    const h = open('```\ncode\n```\n');
    select(h.view, posOf(h.view, 'code', 4));
    const slice = parseClipboardText(
      '*not* **markdown**\nsecond',
      h.view.state.doc.resolve(posOf(h.view, 'code', 4)),
      false,
    );
    h.view.dispatch(h.view.state.tr.replaceSelection(slice));
    expect(h.controller.core.text).toBe('```\ncode*not* **markdown**\nsecond\n```\n');
  });

  it('degrades pasted HTML to text and basic marks, never raw HTML', () => {
    // jsdom has no ClipboardEvent; ProseMirror builds one for `pasteHTML`.
    vi.stubGlobal('ClipboardEvent', class extends Event {});
    const h = open('start\n');
    select(h.view, posOf(h.view, 'start', 5));
    h.view.pasteHTML(
      '<p> Rich <b>bold</b> <i>it</i> <a href="https://e.com">link</a> <a href="javascript:alert(1)">bad</a></p>' +
        '<script>alert(1)</script><style>p{color:red}</style><img src=x onerror=alert(1)>' +
        '<table><tr><td>cell</td></tr></table><iframe src="https://evil.example"></iframe>',
    );
    const text = h.controller.core.text;
    expect(text).toContain('**bold**');
    expect(text).toContain('*it*');
    expect(text).toContain('[link](https://e.com)');
    expect(text).not.toContain('javascript');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('<');
    expect(text).toContain('cell');
    expect(h.view.dom.querySelector('script, style, iframe, img, [onerror]')).toBeNull();
    expect(h.view.dom.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it('copies Markdown text', () => {
    const h = open('some **bold** and `code` and $x$\n');
    h.view.dispatch(h.view.state.tr);
    const slice = h.view.state.doc.slice(1, h.view.state.doc.child(0).content.size + 1);
    expect(sliceToMarkdown(slice)).toBe('some **bold** and `code` and $x$');
  });
});
