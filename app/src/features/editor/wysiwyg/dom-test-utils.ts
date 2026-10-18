import { act } from '@testing-library/react';

import type { EditorDebugElement } from './controller';

/** The editable Write view's root, once it has loaded. */
export function editorRoot(): HTMLElement {
  const root = document.querySelector<HTMLElement>('.md-editor');
  if (!root) throw new Error('the editable Write view is not mounted');
  return root;
}

/** The first text node under `root` containing `text`. */
export function findTextNode(root: Element, text: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ((node as Text).data.includes(text)) return node as Text;
  }
  throw new Error(`no text node contains ${JSON.stringify(text)}`);
}

/** Selects `text` in the editable view the way a pointer drag would (focus, DOM range, selectionchange). */
export function selectInEditor(text: string, root: HTMLElement = editorRoot()) {
  const node = findTextNode(root, text);
  const at = node.data.indexOf(text);
  act(() => {
    root.focus();
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + text.length);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
}

/** The ProseMirror view and core behind the editable Write view (a development and test hook). */
export function editorInternals() {
  const internals = (editorRoot() as EditorDebugElement).__md;
  if (!internals) throw new Error('the editor exposes no internals (a production build?)');
  return internals;
}
