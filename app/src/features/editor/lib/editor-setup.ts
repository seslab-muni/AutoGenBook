import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';

/**
 * The editor's CodeMirror setup, standing in for `@uiw/codemirror-extensions-basic-setup` (the
 * build aliases that module to this file, see `vite.config.ts`). The original is a list of imports
 * and an array literal that its own docs say to copy and adjust; this is that copy, minus what a
 * Markdown/LaTeX source editor never uses and what costs bundle: the autocompletion popup
 * (`@codemirror/autocomplete`'s completion machinery, 16 kB gzipped) and the lint keymap (with
 * `@codemirror/lint`, 6 kB). Everything else is unchanged: line numbers, undo history, the default
 * and search keymaps (the search panel, `Ctrl+F`), bracket matching and closing, selection
 * drawing, rectangular selection, active-line and selection-match highlighting, fold keys.
 * Options use the original's names; `@uiw/react-codemirror` passes the `basicSetup` prop through.
 */
export interface BasicSetupOptions {
  lineNumbers?: boolean;
  highlightActiveLineGutter?: boolean;
  highlightSpecialChars?: boolean;
  history?: boolean;
  foldGutter?: boolean;
  drawSelection?: boolean;
  dropCursor?: boolean;
  allowMultipleSelections?: boolean;
  indentOnInput?: boolean;
  syntaxHighlighting?: boolean;
  bracketMatching?: boolean;
  closeBrackets?: boolean;
  rectangularSelection?: boolean;
  crosshairCursor?: boolean;
  highlightActiveLine?: boolean;
  highlightSelectionMatches?: boolean;
  closeBracketsKeymap?: boolean;
  defaultKeymap?: boolean;
  searchKeymap?: boolean;
  historyKeymap?: boolean;
  foldKeymap?: boolean;
  /** Accepted for compatibility; there is no completion popup in this setup. */
  autocompletion?: boolean;
  completionKeymap?: boolean;
  lintKeymap?: boolean;
  tabSize?: number;
}

export function basicSetup(options: BasicSetupOptions = {}): Extension[] {
  const keymaps = [
    ...(options.closeBracketsKeymap !== false ? closeBracketsKeymap : []),
    ...(options.defaultKeymap !== false ? defaultKeymap : []),
    ...(options.searchKeymap !== false ? searchKeymap : []),
    ...(options.historyKeymap !== false ? historyKeymap : []),
    ...(options.foldKeymap !== false ? foldKeymap : []),
  ];
  const extensions: Extension[] = [];
  if (options.lineNumbers !== false) extensions.push(lineNumbers());
  if (options.highlightActiveLineGutter !== false) extensions.push(highlightActiveLineGutter());
  if (options.highlightSpecialChars !== false) extensions.push(highlightSpecialChars());
  if (options.history !== false) extensions.push(history());
  if (options.foldGutter !== false) extensions.push(foldGutter());
  if (options.drawSelection !== false) extensions.push(drawSelection());
  if (options.dropCursor !== false) extensions.push(dropCursor());
  if (options.allowMultipleSelections !== false) {
    extensions.push(EditorState.allowMultipleSelections.of(true));
  }
  if (options.indentOnInput !== false) extensions.push(indentOnInput());
  if (options.syntaxHighlighting !== false) {
    extensions.push(syntaxHighlighting(defaultHighlightStyle, { fallback: true }));
  }
  if (options.bracketMatching !== false) extensions.push(bracketMatching());
  if (options.closeBrackets !== false) extensions.push(closeBrackets());
  if (options.rectangularSelection !== false) extensions.push(rectangularSelection());
  if (options.crosshairCursor === true) extensions.push(crosshairCursor());
  if (options.highlightActiveLine !== false) extensions.push(highlightActiveLine());
  if (options.highlightSelectionMatches !== false) extensions.push(highlightSelectionMatches());
  if (typeof options.tabSize === 'number')
    extensions.push(indentUnit.of(' '.repeat(options.tabSize)));
  extensions.push(keymap.of(keymaps));
  return extensions;
}

/** Not used by this app; exported because the module this one replaces exports it. */
export function minimalSetup(): Extension[] {
  return [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    keymap.of([...defaultKeymap, ...historyKeymap]),
  ];
}
