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
// Every draft kind carries `anchor` (what it is about, `null` = the whole section): the margin
// positions and highlights drafts from that alone, and renders them through `COMPOSER_KINDS`.

interface MarginState {
  filter: MarginFilter;
  showResolved: boolean;
  /** The thread whose card and highlight are focused. */
  focusedId: string | null;
  /** Asks the margin to move keyboard focus into a card (`nonce` makes repeated requests distinct). */
  focusRequest: { id: string; nonce: number } | null;
  composer: ComposerDraft | null;
  /**
   * Text typed into composers that has not been sent, by `nodeId:scope` (`new`, `reply:<thread>`,
   * `edit:<comment>`). Lives here, not in the composer, so it survives the composer unmounting (a
   * side sheet closing, switching the right pane) and is restored when it reopens; cleared on a
   * successful send or an explicit cancel.
   */
  drafts: Record<string, string>;
  setDraftText: (key: string, text: string) => void;
  clearDraftText: (key: string) => void;
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
  drafts: {},
  setDraftText: (key, text) => set((state) => ({ drafts: { ...state.drafts, [key]: text } })),
  clearDraftText: (key) =>
    set((state) => {
      if (!(key in state.drafts)) return state;
      const { [key]: _removed, ...rest } = state.drafts;
      void _removed;
      return { drafts: rest };
    }),
  setFilter: (filter) => set({ filter }),
  setShowResolved: (showResolved) => set({ showResolved }),
  focus: (focusedId) => set({ focusedId }),
  focusCard: (id) =>
    set((state) => ({
      focusedId: id,
      focusRequest: { id, nonce: (state.focusRequest?.nonce ?? 0) + 1 },
    })),
  openComposer: (composer) =>
    set((state) => ({
      composer,
      focusedId: DRAFT_ID,
      // A stale half-written new comment (from a section the composer was reset in) is not this one.
      drafts: Object.fromEntries(
        Object.entries(state.drafts).filter(([key]) => !key.endsWith(':new')),
      ),
    })),
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

/** Key of a composer's unsent text in the store: per section and per thread (or `new`). */
export function draftKey(nodeId: string, scope: string): string {
  return `${nodeId}:${scope}`;
}
