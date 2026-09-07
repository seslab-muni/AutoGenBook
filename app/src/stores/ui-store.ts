import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Client-only UI state that doesn't belong in TanStack Query (server state)
 * or route search params (shareable/URL state): pane visibility and the one
 * globally-open modal. Nothing from the API is ever copied in here.
 *
 * Theme is deliberately not here — it's owned by `next-themes` (see
 * `app/providers.tsx` and `components/layout/theme-toggle.tsx`), which
 * already persists it and drives the `sonner` toaster's theme.
 */
export type ModalKind =
  'new-project' | 'settings' | 'sources' | 'export' | 'start-run' | 'run-history';

interface UiState {
  outlineOpen: boolean;
  copilotOpen: boolean;
  activeModal: ModalKind | null;
  toggleOutline: () => void;
  toggleCopilot: () => void;
  openModal: (modal: ModalKind) => void;
  closeModal: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      outlineOpen: true,
      copilotOpen: true,
      activeModal: null,
      toggleOutline: () => set((state) => ({ outlineOpen: !state.outlineOpen })),
      toggleCopilot: () => set((state) => ({ copilotOpen: !state.copilotOpen })),
      openModal: (modal) => set({ activeModal: modal }),
      closeModal: () => set({ activeModal: null }),
    }),
    {
      name: 'autogenbook-ui',
      // Only pane visibility is worth remembering across reloads; `activeModal`
      // always starts closed.
      partialize: (state) => ({ outlineOpen: state.outlineOpen, copilotOpen: state.copilotOpen }),
    },
  ),
);

export const useOutlineOpen = (): boolean => useUiStore((state) => state.outlineOpen);
export const useCopilotOpen = (): boolean => useUiStore((state) => state.copilotOpen);
export const useActiveModal = (): ModalKind | null => useUiStore((state) => state.activeModal);
