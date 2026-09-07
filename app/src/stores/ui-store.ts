import { create } from 'zustand';

/**
 * Minimal example of the Zustand convention for this codebase: one small,
 * focused store per concern under `src/stores`, exporting a typed hook.
 *
 * This store itself is a placeholder — client-only UI state (panel/drawer
 * open state, selected tab, etc.) that doesn't belong in TanStack Query
 * (server state) or route search params (shareable/URL state). Real state
 * lands here starting in #16.
 */
interface UiState {
  isSidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  isSidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ isSidebarCollapsed: !state.isSidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ isSidebarCollapsed: collapsed }),
}));
