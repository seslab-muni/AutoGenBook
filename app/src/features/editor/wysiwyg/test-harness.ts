import type { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import { vi } from 'vitest';

import { AtomHost } from './node-views';
import { EditorController, type ControllerProps } from './controller';

/** Props for a controller test: inert callbacks as spies, overridable. */
export function makeProps(
  value: string,
  overrides: Partial<ControllerProps> = {},
): ControllerProps {
  return {
    value,
    onChange: vi.fn(),
    onFlush: vi.fn(),
    readOnly: false,
    citations: [],
    highlights: [],
    focusedId: null,
    onHighlightClick: vi.fn(),
    onHighlightsMapped: vi.fn(),
    onSelectionChange: vi.fn(),
    onEditInSource: vi.fn(),
    onRefused: vi.fn(),
    requestLink: () => 'https://linked.example',
    placeholder: 'Start writing…',
    ariaLabel: 'Section text',
    ...overrides,
  };
}

export interface Harness {
  controller: EditorController;
  view: EditorView;
  props: ControllerProps;
  container: HTMLElement;
  destroy: () => void;
}

export function mount(value: string, overrides: Partial<ControllerProps> = {}): Harness {
  const container = document.createElement('div');
  document.body.append(container);
  const props = makeProps(value, overrides);
  const controller = new EditorController(container, props, new AtomHost());
  return {
    controller,
    view: controller.view,
    props,
    container,
    destroy: () => {
      controller.destroy();
      container.remove();
    },
  };
}

/** Types text the way ProseMirror's input handling does: text-input rules first, then the plain insertion. */
export function type(view: EditorView, text: string) {
  for (const char of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp('handleTextInput', (f) =>
      f(view, from, to, char, () => view.state.tr.insertText(char, from, to)),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(char, from, to));
  }
}

/** Presses a key through the editor's key handlers; returns whether one handled it. */
export function press(
  view: EditorView,
  key: string,
  modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
): boolean {
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: modifiers.ctrl ?? false,
    shiftKey: modifiers.shift ?? false,
    altKey: modifiers.alt ?? false,
    bubbles: true,
    cancelable: true,
  });
  return !!view.someProp('handleKeyDown', (f) => f(view, event));
}

/** Puts the caret (or a range) at editor positions. */
export function select(view: EditorView, from: number, to = from) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

/** Editor position of the `offset`th character of the first text containing `needle`. */
export function posOf(view: EditorView, needle: string, offset = 0): number {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return found < 0;
    const i = node.text!.indexOf(needle);
    if (i >= 0) found = pos + i;
    return false;
  });
  if (found < 0) throw new Error(`no text ${needle}`);
  return found + offset;
}

/** The latest value passed to `onChange`. */
export function lastChange(props: ControllerProps): string | undefined {
  const calls = (props.onChange as ReturnType<typeof vi.fn>).mock.calls;
  return calls.at(-1)?.[0] as string | undefined;
}
