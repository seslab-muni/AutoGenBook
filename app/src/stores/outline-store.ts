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
  /** Whether `collapsedByProject[projectId]` has already been seeded for a large outline (see `seedCollapsed`) — an empty array is otherwise indistinguishable from "user expanded everything". */
  seededByProject: Record<string, boolean>;
  toggleCollapsed: (projectId: string, nodeId: string) => void;
  expand: (projectId: string, nodeIds: readonly string[]) => void;
  isCollapsed: (projectId: string, nodeId: string) => boolean;
  /**
   * One-time (per project) default-collapse for a large outline: collapses `collapseIds` except
   * those in `keepExpandedIds` (the path to whatever's selected). No-ops if already seeded, so it's
   * safe to call from an effect on every render — manual expand/collapse afterwards stays authoritative.
   */
  seedCollapsed: (
    projectId: string,
    collapseIds: readonly string[],
    keepExpandedIds: readonly string[],
  ) => void;
  expandAll: (projectId: string) => void;
  collapseAll: (projectId: string, nodeIds: readonly string[]) => void;
}

export const useOutlineStore = create<OutlineState>()(
  persist(
    (set, get) => ({
      collapsedByProject: {},
      seededByProject: {},
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
      seedCollapsed: (projectId, collapseIds, keepExpandedIds) =>
        set((state) => {
          if (state.seededByProject[projectId]) return state;
          const keep = new Set(keepExpandedIds);
          const collapsed = collapseIds.filter((id) => !keep.has(id));
          return {
            collapsedByProject: { ...state.collapsedByProject, [projectId]: collapsed },
            seededByProject: { ...state.seededByProject, [projectId]: true },
          };
        }),
      expandAll: (projectId) =>
        set((state) => ({
          collapsedByProject: { ...state.collapsedByProject, [projectId]: [] },
        })),
      collapseAll: (projectId, nodeIds) =>
        set((state) => ({
          collapsedByProject: { ...state.collapsedByProject, [projectId]: [...nodeIds] },
        })),
    }),
    { name: 'autogenbook-outline' },
  ),
);

export function useIsNodeCollapsed(projectId: string, nodeId: string): boolean {
  return useOutlineStore((state) => (state.collapsedByProject[projectId] ?? []).includes(nodeId));
}
