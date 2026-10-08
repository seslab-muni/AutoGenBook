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
  'new-project' | 'settings' | 'sources' | 'export' | 'start-run' | 'run-history' | 'account';

/** Default width (px) of the outline pane — matches the old fixed `lg:w-80`. */
export const DEFAULT_OUTLINE_WIDTH = 320;
export const MIN_OUTLINE_WIDTH = 240;
export const MAX_OUTLINE_WIDTH = 560;

interface UiState {
  outlineOpen: boolean;
  /** The right column (the margin workspace) is open - the wide-screen preference. */
  marginOpen: boolean;
  /** Narrow screens show the right column as an overlay instead; this is its (unpersisted) open state. */
  rightOverlayOpen: boolean;
  outlineWidth: number;
  activeModal: ModalKind | null;
  toggleOutline: () => void;
  toggleMargin: () => void;
  setRightOverlayOpen: (open: boolean) => void;
  setOutlineWidth: (width: number) => void;
  openModal: (modal: ModalKind) => void;
  closeModal: () => void;
}

/** What is kept across reloads. */
interface PersistedUi {
  outlineOpen: boolean;
  marginOpen: boolean;
  outlineWidth: number;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      outlineOpen: true,
      marginOpen: true,
      rightOverlayOpen: false,
      outlineWidth: DEFAULT_OUTLINE_WIDTH,
      activeModal: null,
      toggleOutline: () => set((state) => ({ outlineOpen: !state.outlineOpen })),
      toggleMargin: () => set((state) => ({ marginOpen: !state.marginOpen })),
      setRightOverlayOpen: (rightOverlayOpen) => set({ rightOverlayOpen }),
      setOutlineWidth: (width) =>
        set({
          outlineWidth: Math.min(MAX_OUTLINE_WIDTH, Math.max(MIN_OUTLINE_WIDTH, width)),
        }),
      openModal: (modal) => set({ activeModal: modal }),
      closeModal: () => set({ activeModal: null }),
    }),
    {
      name: 'autogenbook-ui',
      version: 1,
      // v0 stored `copilotOpen` (the right column's wide-screen state) and `rightPane`
      // (`margin | copilot`, from when the legacy copilot drawer shared the column). The drawer is
      // gone: keep the open/closed preference under its new name and drop the switch.
      migrate: (persisted) => {
        const {
          copilotOpen,
          rightPane: _rightPane,
          ...rest
        } = (persisted ?? {}) as Record<string, unknown>;
        void _rightPane;
        return {
          ...rest,
          ...(typeof copilotOpen === 'boolean' && rest['marginOpen'] === undefined
            ? { marginOpen: copilotOpen }
            : {}),
        } as unknown as PersistedUi;
      },
      // Only pane visibility/size is worth remembering across reloads; `activeModal`
      // always starts closed.
      partialize: (state) => ({
        outlineOpen: state.outlineOpen,
        marginOpen: state.marginOpen,
        outlineWidth: state.outlineWidth,
      }),
    },
  ),
);

export const useOutlineOpen = (): boolean => useUiStore((state) => state.outlineOpen);
export const useOutlineWidth = (): number => useUiStore((state) => state.outlineWidth);
export const useActiveModal = (): ModalKind | null => useUiStore((state) => state.activeModal);
