import { create } from 'zustand';

import type { Anchor } from '@/features/editor/lib/anchors';
import type { MarginFilter } from './threads';

/**
 * A card being written that has no thread yet. A discriminated union so phase 4 can add the prompt
 * window's draft (`{ kind: 'prompt'; scope; instruction; ... }`) next to the comment composer
 * without touching consumers that only care about comments: they narrow on `kind`.
 */
export type ComposerDraft = {
  kind: 'comment';
  /** The text the comment is about; `null` = the whole section. */
  anchor: Anchor | null;
};

interface MarginState {
  filter: MarginFilter;
  showResolved: boolean;
  /** The thread whose card and highlight are focused. */
  focusedId: string | null;
  /** Asks the margin to move keyboard focus into a card (`nonce` makes repeated requests distinct). */
  focusRequest: { id: string; nonce: number } | null;
  composer: ComposerDraft | null;
  setFilter: (filter: MarginFilter) => void;
  setShowResolved: (show: boolean) => void;
  focus: (id: string | null) => void;
  /** Focus the card (and its highlight) and move keyboard focus into it. */
  focusCard: (id: string) => void;
  openComposer: (draft: ComposerDraft) => void;
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
  focusRequest: null,
  composer: null,
  setFilter: (filter) => set({ filter }),
  setShowResolved: (showResolved) => set({ showResolved }),
  focus: (focusedId) => set({ focusedId }),
  focusCard: (id) =>
    set((state) => ({
      focusedId: id,
      focusRequest: { id, nonce: (state.focusRequest?.nonce ?? 0) + 1 },
    })),
  openComposer: (composer) => set({ composer, focusedId: DRAFT_ID }),
  closeComposer: () =>
    set((state) => ({
      composer: null,
      focusedId: state.focusedId === DRAFT_ID ? null : state.focusedId,
    })),
  reset: () =>
    set({
      filter: 'all',
      showResolved: false,
      focusedId: null,
      focusRequest: null,
      composer: null,
    }),
}));

/** The id the composer's pseudo-card and its highlight use. */
export const DRAFT_ID = 'draft';
