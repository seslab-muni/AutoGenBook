import { create } from 'zustand';

import type { Anchor } from '@/features/editor/lib/anchors';
import type { MarginFilter } from './threads';

/** A comment being written that has no thread yet: the anchor it will carry (`null` = whole section). */
export interface ComposerDraft {
  anchor: Anchor | null;
}

interface MarginState {
  filter: MarginFilter;
  showResolved: boolean;
  /** The thread whose card and highlight are focused. */
  focusedId: string | null;
  composer: ComposerDraft | null;
  setFilter: (filter: MarginFilter) => void;
  setShowResolved: (show: boolean) => void;
  focus: (id: string | null) => void;
  openComposer: (anchor: Anchor | null) => void;
  closeComposer: () => void;
  reset: () => void;
}

/**
 * Margin UI state shared by the highlights (which focus a card), the selection toolbar (which
 * opens the composer) and the margin itself. Per open section: `ManuscriptSheet` resets it.
 */
export const useMarginStore = create<MarginState>()((set) => ({
  filter: 'all',
  showResolved: false,
  focusedId: null,
  composer: null,
  setFilter: (filter) => set({ filter }),
  setShowResolved: (showResolved) => set({ showResolved }),
  focus: (focusedId) => set({ focusedId }),
  openComposer: (anchor) => set({ composer: { anchor }, focusedId: 'draft' }),
  closeComposer: () =>
    set((state) => ({
      composer: null,
      focusedId: state.focusedId === 'draft' ? null : state.focusedId,
    })),
  reset: () => set({ filter: 'all', showResolved: false, focusedId: null, composer: null }),
}));

/** The id the composer's pseudo-card and its highlight use. */
export const DRAFT_ID = 'draft';
