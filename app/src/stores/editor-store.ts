import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type EditorView = 'write' | 'source';

/**
 * The centre pane's Write/Source toggle (`ManuscriptSheet`) — a single
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
      view: 'write',
      setView: (view) => set({ view }),
    }),
    {
      name: 'autogenbook-editor',
      version: 1,
      // v0 called the rendered view 'preview'; it is the Write view now.
      migrate: (persisted) => {
        const view = (persisted as { view?: string } | null)?.view;
        return { view: view === 'source' ? 'source' : 'write' } as EditorState;
      },
    },
  ),
);

export const useEditorView = (): EditorView => useEditorStore((state) => state.view);
