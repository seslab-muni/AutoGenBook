import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Per-project outline tree UI state: which nodes are collapsed. Keyed by
 * project id (rather than global) since a viewer can hold multiple projects'
 * trees open across tabs/sessions and each should remember its own shape.
 * Kept separate from `ui-store.ts` (pane visibility/modals), which is
 * deliberately project-agnostic.
 */
interface OutlineState {
  collapsedByProject: Record<string, string[]>;
  toggleCollapsed: (projectId: string, nodeId: string) => void;
  expand: (projectId: string, nodeIds: readonly string[]) => void;
  isCollapsed: (projectId: string, nodeId: string) => boolean;
}

export const useOutlineStore = create<OutlineState>()(
  persist(
    (set, get) => ({
      collapsedByProject: {},
      toggleCollapsed: (projectId, nodeId) =>
        set((state) => {
          const collapsed = new Set(state.collapsedByProject[projectId] ?? []);
          if (collapsed.has(nodeId)) collapsed.delete(nodeId);
          else collapsed.add(nodeId);
          return {
            collapsedByProject: { ...state.collapsedByProject, [projectId]: [...collapsed] },
          };
        }),
      /** Ensures `nodeIds` are NOT collapsed — used to expand the path to a newly selected node. */
      expand: (projectId, nodeIds) =>
        set((state) => {
          const collapsed = new Set(state.collapsedByProject[projectId] ?? []);
          let changed = false;
          for (const id of nodeIds) {
            if (collapsed.delete(id)) changed = true;
          }
          if (!changed) return state;
          return {
            collapsedByProject: { ...state.collapsedByProject, [projectId]: [...collapsed] },
          };
        }),
      isCollapsed: (projectId, nodeId) =>
        (get().collapsedByProject[projectId] ?? []).includes(nodeId),
    }),
    { name: 'autogenbook-outline' },
  ),
);

export function useIsNodeCollapsed(projectId: string, nodeId: string): boolean {
  return useOutlineStore((state) => (state.collapsedByProject[projectId] ?? []).includes(nodeId));
}
