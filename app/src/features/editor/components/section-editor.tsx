import { markdown as markdownLang } from '@codemirror/lang-markdown';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { EditorState, Transaction, type Text } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import CodeMirror, { ExternalChange } from '@uiw/react-codemirror';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import {
  anchorHighlightField,
  anchorIdsAt,
  anchorRangesOf,
} from '@/features/editor/lib/cm-anchor-highlights';
import type { TextRange } from '@/features/editor/lib/anchors';

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
  /** Selects this range (UTF-16 offsets) and scrolls it into view when the editor is created. */
  initialSelection?: { from: number; to: number; reveal?: boolean } | null;
  /** Fired once the initial selection has been applied (so the owner can forget it). */
  onInitialSelectionApplied?: () => void;
  /** Fired with the anchor ids under a click on a highlighted range (innermost first). Identity may change freely. */
  onHighlightClick?: (ids: string[]) => void;
  /**
   * After every edit: where each tracked highlight sits now (`null` = an edit swallowed it) and
   * whether the edit was the controlled `value` prop being applied from outside (a replace-all that
   * says nothing about where anchors went). Identity may change freely.
   */
  onHighlightsMapped?: (ranges: Map<string, TextRange | null>, external: boolean) => void;
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
  onHighlightClick,
  onHighlightsMapped,
  initialSelection = null,
  onInitialSelectionApplied,
  className,
}: SectionEditorProps) {
  // Read through a ref so a new callback never reconfigures the editor.
  const highlightClickRef = useRef(onHighlightClick);
  useEffect(() => {
    highlightClickRef.current = onHighlightClick;
  }, [onHighlightClick]);
  const mappedRef = useRef(onHighlightsMapped);
  useEffect(() => {
    mappedRef.current = onHighlightsMapped;
  }, [onHighlightsMapped]);
  const emitMapped = useCallback(
    (ranges: Map<string, TextRange | null>, external: boolean) =>
      mappedRef.current?.(ranges, external),
    [],
  );

  const extensions = useMemo(
    () => [
      language === 'latex' ? StreamLanguage.define(stex) : markdownLang(),
      EditorView.lineWrapping,
      // Text applied from outside (server content, an accepted suggestion) is not the user's edit:
      // undoing it would bring back what the other side replaced, and the next autosave would save that.
      EditorState.transactionExtender.of((tr) =>
        tr.annotation(ExternalChange) ? { annotations: Transaction.addToHistory.of(false) } : null,
      ),
      EditorView.contentAttributes.of({
        'aria-label': language === 'latex' ? 'Section LaTeX source' : 'Section Markdown source',
      }),
      anchorHighlightField,
      // The listener reaches the latest callbacks through refs when an edit happens, never while rendering.
      // eslint-disable-next-line react-hooks/refs
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged)
          onSelectionChange?.(selectionOf(update.state));
        if (update.docChanged) {
          const external = update.transactions.some((tr) => tr.annotation(ExternalChange) === true);
          emitMapped(anchorRangesOf(update.state), external);
        }
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
    [language, onFlush, onSelectionChange, emitMapped],
  );

  const basicSetup = useMemo(
    () => ({ foldGutter: false, highlightActiveLine: !readOnly }),
    [readOnly],
  );

  function handleCreate(view: EditorView) {
    if (initialSelection) {
      const length = view.state.doc.length;
      const anchor = Math.min(initialSelection.from, length);
      const head = Math.min(initialSelection.to, length);
      view.dispatch({
        selection: { anchor, head },
        ...(initialSelection.reveal === false
          ? {}
          : { effects: EditorView.scrollIntoView(anchor, { y: 'center' }) }),
      });
      onInitialSelectionApplied?.();
    }
    onSelectionChange?.(selectionOf(view.state));
    view.dom.addEventListener('click', (event) => {
      const ids = anchorIdsAt(event.target);
      if (ids.length > 0) highlightClickRef.current?.(ids);
    });
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

/** Surrogate pairs (astral code points) in `text`: UTF-16 length minus code-point count. */
function astralCount(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length - 1; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        count += 1;
        i += 1;
      }
    }
  }
  return count;
}

/**
 * Astral characters before each line start, built once per document version. A caret move then
 * costs a lookup plus a scan of the caret's own line, not of the whole document (only an edit,
 * which creates a new `Text`, pays one pass — the same order as the draft's word/character counts).
 */
const astralBeforeLine = new WeakMap<Text, number[]>();

function astralBefore(doc: Text, pos: number): number {
  let prefix = astralBeforeLine.get(doc);
  if (!prefix) {
    prefix = [0];
    let running = 0;
    for (const line of doc.iterLines()) {
      running += astralCount(line);
      prefix.push(running);
    }
    astralBeforeLine.set(doc, prefix);
  }
  const line = doc.lineAt(pos);
  return (prefix[line.number - 1] ?? 0) + astralCount(line.text.slice(0, pos - line.from));
}

/** `pos` (UTF-16 offset) as a code-point offset over the document. */
function codePointOffset(doc: Text, pos: number): number {
  return pos - astralBefore(doc, pos);
}

function selectionOf(state: EditorState): EditorSelection {
  const { head, from, to } = state.selection.main;
  const line = state.doc.lineAt(head);
  return {
    from: codePointOffset(state.doc, from),
    to: codePointOffset(state.doc, to),
    line: line.number,
    column: head - line.from - astralCount(line.text.slice(0, head - line.from)) + 1,
  };
}
