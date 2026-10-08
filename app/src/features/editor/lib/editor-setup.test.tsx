import { act, render } from '@testing-library/react';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import { SectionEditor } from '@/features/editor/components/section-editor';
import * as upstream from '@uiw/codemirror-extensions-basic-setup';
import * as ours from './editor-setup';

function mount(value: string) {
  let view: EditorView | null = null;
  const result = render(
    <SectionEditor
      value={value}
      onChange={() => {}}
      onFlush={() => {}}
      onCreateEditor={(created) => {
        view = created;
      }}
    />,
  );
  if (!view) throw new Error('editor not created');
  return { view: view as EditorView, ...result };
}

const key = (view: EditorView, init: KeyboardEventInit) =>
  runScopeHandlers(
    view,
    new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    'editor',
  );

describe('the editor uses the trimmed setup', () => {
  it('resolves the upstream basic-setup import to lib/editor-setup in every environment', () => {
    // If this fails, the alias in vite.config.ts is not applied here and the app build may not
    // apply it either (the bundle budget script checks the build itself).
    expect(upstream.basicSetup).toBe(ours.basicSetup);
  });

  it('is what the mounted editor runs: no completion or lint keymaps', () => {
    // Unlike the identity check above, this fails whenever the editor was built from the upstream
    // setup, however the alias is (not) applied.
    const { view } = mount('abc');
    const keys = view.state
      .facet(keymap)
      .flat()
      .flatMap((binding) => [binding.key, binding.mac, binding.win, binding.linux])
      .filter(Boolean);
    expect(keys).not.toContain('Ctrl-Space'); // completionKeymap: start completion
    expect(keys).not.toContain('Mod-Shift-m'); // lintKeymap: open the diagnostics panel
    expect(keys).toContain('Mod-f'); // the search keymap is kept
  });

  it('opens the search panel with Ctrl+F', () => {
    const { view } = mount('find me\nand me');
    act(() => {
      key(view, { key: 'f', ctrlKey: true });
    });
    expect(view.dom.querySelector('.cm-search')).not.toBeNull();
  });

  it('undoes and redoes with Ctrl+Z / Ctrl+Y', () => {
    const { view } = mount('abc');
    act(() => {
      view.dispatch({ changes: { from: 3, insert: 'd' }, userEvent: 'input.type' });
    });
    expect(view.state.doc.toString()).toBe('abcd');
    act(() => {
      key(view, { key: 'z', ctrlKey: true });
    });
    expect(view.state.doc.toString()).toBe('abc');
    act(() => {
      key(view, { key: 'y', ctrlKey: true });
    });
    expect(view.state.doc.toString()).toBe('abcd');
  });

  it('closes a typed bracket', () => {
    const { view } = mount('');
    const handled = view.state
      .facet(EditorView.inputHandler)
      .some((handler) =>
        handler(view, 0, 0, '(', () => view.state.update({ changes: { from: 0, insert: '(' } })),
      );
    expect(handled).toBe(true);
    expect(view.state.doc.toString()).toBe('()');
  });

  it('indents with Tab (the editor would otherwise trap focus differently) and outdents with Shift+Tab', () => {
    const { view } = mount('line');
    act(() => {
      view.dispatch({ selection: { anchor: 0 } });
      key(view, { key: 'Tab' });
    });
    expect(view.state.doc.toString()).toMatch(/^\s+line$/);
    act(() => {
      key(view, { key: 'Tab', shiftKey: true });
    });
    expect(view.state.doc.toString()).toBe('line');
  });

  it("keeps line numbers, and the original's options keep working", () => {
    const { view } = mount('a\nb');
    expect(view.dom.querySelector('.cm-lineNumbers')).not.toBeNull();
    const full = ours.basicSetup().length;
    expect(ours.basicSetup({ lineNumbers: false }).length).toBe(full - 1);
    // A tab size of 0 is no tab size (as in the original), not an empty indent unit.
    expect(ours.basicSetup({ tabSize: 0 }).length).toBe(full);
    expect(ours.basicSetup({ tabSize: 4 }).length).toBe(full + 1);
    const minimal = ours.minimalSetup().length;
    expect(ours.minimalSetup({ history: false }).length).toBe(minimal - 1);
  });
});
