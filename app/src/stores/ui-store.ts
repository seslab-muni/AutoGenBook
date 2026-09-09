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

/** Default width (px) of the outline pane — matches the old fixed `lg:w-80`. */
export const DEFAULT_OUTLINE_WIDTH = 320;
export const MIN_OUTLINE_WIDTH = 240;
export const MAX_OUTLINE_WIDTH = 560;

interface UiState {
  outlineOpen: boolean;
  copilotOpen: boolean;
  outlineWidth: number;
  activeModal: ModalKind | null;
  toggleOutline: () => void;
  toggleCopilot: () => void;
  setOutlineWidth: (width: number) => void;
  openModal: (modal: ModalKind) => void;
  closeModal: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      outlineOpen: true,
      copilotOpen: true,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
      activeModal: null,
      toggleOutline: () => set((state) => ({ outlineOpen: !state.outlineOpen })),
      toggleCopilot: () => set((state) => ({ copilotOpen: !state.copilotOpen })),
      setOutlineWidth: (width) =>
        set({
          outlineWidth: Math.min(MAX_OUTLINE_WIDTH, Math.max(MIN_OUTLINE_WIDTH, width)),
        }),
      openModal: (modal) => set({ activeModal: modal }),
      closeModal: () => set({ activeModal: null }),
    }),
    {
      name: 'autogenbook-ui',
      // Only pane visibility/size is worth remembering across reloads; `activeModal`
      // always starts closed.
      partialize: (state) => ({
        outlineOpen: state.outlineOpen,
        copilotOpen: state.copilotOpen,
        outlineWidth: state.outlineWidth,
      }),
    },
  ),
);

export const useOutlineOpen = (): boolean => useUiStore((state) => state.outlineOpen);
export const useCopilotOpen = (): boolean => useUiStore((state) => state.copilotOpen);
export const useOutlineWidth = (): number => useUiStore((state) => state.outlineWidth);
export const useActiveModal = (): ModalKind | null => useUiStore((state) => state.activeModal);
