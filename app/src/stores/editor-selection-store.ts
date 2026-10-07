import { create } from 'zustand';

/**
 * The Source view's caret/selection over the section's Markdown source (issue #182). Offsets
 * (`from`/`to`, `from <= to`) count Unicode code points from the start of the document, the unit
 * anchors use (phase 2); `line` and `column` are 1-based and describe the selection head, with
 * the column also in code points. `null` when no source editor is mounted (Write view).
 *
 * Lives in a store, not `ManuscriptSheet` state, so a caret move re-renders only its readers
 * (the status bar) and never the sheet or the CodeMirror wrapper.
 */
export interface EditorSelection {
  from: number;
  to: number;
  line: number;
  column: number;
}

interface EditorSelectionState {
  selection: EditorSelection | null;
  setSelection: (selection: EditorSelection | null) => void;
}

export const useEditorSelectionStore = create<EditorSelectionState>()((set, get) => ({
  selection: null,
  setSelection: (selection) => {
    const current = get().selection;
    if (current === selection) return;
    if (
      current &&
      selection &&
      current.from === selection.from &&
      current.to === selection.to &&
      current.line === selection.line &&
      current.column === selection.column
    ) {
      return;
    }
    set({ selection });
  },
}));
