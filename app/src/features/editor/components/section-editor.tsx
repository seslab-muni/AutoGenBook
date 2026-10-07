import { markdown as markdownLang } from '@codemirror/lang-markdown';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import type { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { useMemo } from 'react';

import { characterCount } from '@/features/editor/lib/word-count';
import type { EditorSelection } from '@/stores/editor-selection-store';

interface SectionEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Fired on blur and on `Ctrl`/`Cmd`-S — the two non-debounce autosave triggers CodeMirror can see directly. */
  onFlush: () => void;
  readOnly?: boolean;
  /** LaTeX mode (`--legacy-tex` runs) instead of the default Markdown mode. */
  language?: 'markdown' | 'latex';
  /** CodeMirror's built-in light/dark theme — pass the app's resolved theme so it doesn't clash. */
  theme?: 'light' | 'dark';
  /**
   * Fired on mount and whenever the selection or document changes, with offsets in code points
   * over the document. Keep its identity stable: a new one reconfigures the editor.
   */
  onSelectionChange?: (selection: EditorSelection) => void;
  /** Hands the CodeMirror view to the caller (highlights, selection toolbar) once it exists. */
  onCreateEditor?: (view: EditorView) => void;
  className?: string;
}

/**
 * Thin, controlled CodeMirror 6 wrapper — all autosave/dirty-tracking state
 * lives in `ManuscriptSheet`, which owns the debounced mutation and passes
 * `value`/`onChange` down, so `SectionEditor` itself stays presentation-only
 * and easy to swap out (chosen over a plain `Textarea` for real Markdown/LaTeX
 * syntax highlighting; see the PR description for the bundle-size tradeoff).
 */
export function SectionEditor({
  value,
  onChange,
  onFlush,
  readOnly = false,
  language = 'markdown',
  theme = 'light',
  onSelectionChange,
  onCreateEditor,
  className,
}: SectionEditorProps) {
  const extensions = useMemo(
    () => [
      language === 'latex' ? StreamLanguage.define(stex) : markdownLang(),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged)
          onSelectionChange?.(selectionOf(update.state));
      }),
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            onFlush();
            return true;
          },
        },
      ]),
    ],
    [language, onFlush, onSelectionChange],
  );

  const basicSetup = useMemo(
    () => ({ foldGutter: false, highlightActiveLine: !readOnly }),
    [readOnly],
  );

  function handleCreate(view: EditorView) {
    onSelectionChange?.(selectionOf(view.state));
    onCreateEditor?.(view);
  }

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      onBlur={onFlush}
      onCreateEditor={handleCreate}
      readOnly={readOnly}
      extensions={extensions}
      basicSetup={basicSetup}
      theme={theme}
      height="100%"
      className={className}
    />
  );
}

function selectionOf(state: EditorState): EditorSelection {
  const { head, from, to } = state.selection.main;
  const line = state.doc.lineAt(head);
  return {
    from: characterCount(state.doc.sliceString(0, from)),
    to: characterCount(state.doc.sliceString(0, to)),
    line: line.number,
    column: characterCount(state.doc.sliceString(line.from, head)) + 1,
  };
}
