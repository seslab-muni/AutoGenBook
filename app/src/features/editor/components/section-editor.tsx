import { markdown as markdownLang } from '@codemirror/lang-markdown';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { useMemo } from 'react';

/** 1-based caret position in the document. */
export interface EditorCaret {
  line: number;
  column: number;
}

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
  /** Fired on mount and whenever the selection head moves or the document changes. Keep its identity stable: a new one reconfigures the editor. */
  onCaretChange?: (caret: EditorCaret) => void;
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
  onCaretChange,
  className,
}: SectionEditorProps) {
  const extensions = useMemo(
    () => [
      language === 'latex' ? StreamLanguage.define(stex) : markdownLang(),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) onCaretChange?.(caretOf(update.state));
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
    [language, onFlush, onCaretChange],
  );

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      onBlur={onFlush}
      onCreateEditor={(view) => onCaretChange?.(caretOf(view.state))}
      readOnly={readOnly}
      extensions={extensions}
      basicSetup={{ foldGutter: false, highlightActiveLine: !readOnly }}
      theme={theme}
      height="100%"
      className={className}
    />
  );
}

function caretOf(state: EditorState): EditorCaret {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { line: line.number, column: head - line.from + 1 };
}
