import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type EditorView = 'preview' | 'source';

/**
 * The centre pane's Preview/Source toggle (`ManuscriptSheet`) — a single
 * global preference (not per-node/per-project) since a viewer picking
 * "Source" is almost always expressing "I want to write Markdown", not a
 * one-off for a single section.
 */
interface EditorState {
  view: EditorView;
  setView: (view: EditorView) => void;
}

export const useEditorStore = create<EditorState>()(
  persist(
    (set) => ({
      view: 'preview',
      setView: (view) => set({ view }),
    }),
    { name: 'autogenbook-editor' },
  ),
);

export const useEditorView = (): EditorView => useEditorStore((state) => state.view);
