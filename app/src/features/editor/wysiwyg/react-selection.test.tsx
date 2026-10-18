import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { keepReactOutOfTheEditor } from './controller';

/**
 * `keepReactOutOfTheEditor` rests on how React behaves: before every commit it saves the focused
 * element's selection, and for an element whose `contentEditable` reads "true" it does so by
 * walking the element's whole DOM tree. This test watches React itself: if React stops doing that
 * (so the workaround is no longer needed), or the workaround stops keeping it out (so the editor is
 * slow again on a long section), it fails and says which.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'contentEditable');
beforeEach(() => {
  // (jsdom has no contentEditable property; a browser has this accessor.)
  Object.defineProperty(HTMLElement.prototype, 'contentEditable', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('contenteditable') ?? 'inherit';
    },
    set(this: HTMLElement, value: string) {
      this.setAttribute('contenteditable', value);
    },
  });
});
afterEach(() => {
  if (descriptor) Object.defineProperty(HTMLElement.prototype, 'contentEditable', descriptor);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>)['contentEditable'];
  document.body.innerHTML = '';
});

/** How many times React walked the focused editable element during commits that touch only React's own DOM. */
function selectionWalks(shield: boolean): number {
  const editor = document.createElement('div');
  editor.setAttribute('contenteditable', 'true');
  editor.tabIndex = 0;
  for (let i = 0; i < 50; i += 1) editor.append(document.createTextNode(`line ${i} `));
  const host = document.createElement('div');
  const react = document.createElement('div');
  document.body.append(host);
  host.append(editor, react);
  if (shield) expect(keepReactOutOfTheEditor(editor)).toBe(true);
  editor.focus();
  const selection = document.getSelection()!;
  selection.collapse(editor.firstChild, 3);
  expect(document.activeElement).toBe(editor);

  const root: Root = createRoot(react);
  act(() => root.render(<p>one</p>));
  // Walking the editor reads `firstChild` of its text nodes (React counts text offsets that way).
  const first = Object.getOwnPropertyDescriptor(Node.prototype, 'firstChild')!;
  let walks = 0;
  Object.defineProperty(Node.prototype, 'firstChild', {
    configurable: true,
    get(this: Node) {
      if (this.nodeType === Node.TEXT_NODE && editor.contains(this)) walks += 1;
      return first.get!.call(this) as ChildNode | null;
    },
  });
  try {
    act(() => root.render(<p>two</p>));
    act(() => root.render(<p>three</p>));
  } finally {
    Object.defineProperty(Node.prototype, 'firstChild', first);
  }
  act(() => root.unmount());
  return walks;
}

describe('React and a focused contenteditable', () => {
  it('still saves and restores the selection of an editable element by walking it (so the workaround is needed)', () => {
    expect(selectionWalks(false)).toBeGreaterThan(0);
  });

  it('does not walk the editor once it is shielded', () => {
    expect(selectionWalks(true)).toBe(0);
  });
});
