import { create } from 'zustand';

import type { Anchor } from '@/features/editor/lib/anchors';
import type { MarginFilter } from './threads';

/** The prompt window's parameter chips (typed toggles, not pasted prose). */
export interface PromptChips {
  moreProofs: boolean;
  moreExamples: boolean;
  moreRigorous: boolean;
  /** `shorter` and `longer` exclude each other: at most one. */
  length: 'shorter' | 'longer' | null;
  citeSources: boolean;
  /** Fix the open review cards in scope (`fixIssueIds`). */
  fixIssues: boolean;
  /** Address the open comment threads in scope (`addressCommentIds`). */
  addressComments: boolean;
}

export function noChips(): PromptChips {
  return {
    moreProofs: false,
    moreExamples: false,
    moreRigorous: false,
    length: null,
    citeSources: false,
    fixIssues: false,
    addressComments: false,
  };
}

/** Where the prompt window was opened from: where keyboard focus returns when it closes. */
export type PromptOrigin = 'selection' | 'header' | 'retry';

/**
 * A card being written that has no thread yet. A discriminated union: the comment composer and the
 * prompt window (the copilot's, with its scope, chips and verb), each rendered through
 * `COMPOSER_KINDS`; consumers that only care about one kind narrow on `kind`. The prompt's
 * instruction text lives in `drafts` (keyed `<node>:prompt`) like every unsent text.
 */
export type ComposerDraft =
  | {
      kind: 'comment';
      /** The text the comment is about; `null` = the whole section. */
      anchor: Anchor | null;
    }
  | {
      kind: 'prompt';
      /** The text the prompt is about, locked to the range; `null` = the whole section. */
      anchor: Anchor | null;
      verb: 'revise' | 'rewrite';
      chips: PromptChips;
      origin: PromptOrigin;
      /** A suggestion this request replaces (Try again): rejected or dismissed once the new one starts. */
      replaces: { id: string; status: string } | null;
      /** The comment or review thread the suggestion should arrive in (Try again on one that did). */
      threadId: string | null;
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
  /** Asks the margin to scroll a card into view and focus its highlight, without moving keyboard focus. */
  revealRequest: { id: string; nonce: number } | null;
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
  /** Scroll the card into view and focus its highlight, leaving keyboard focus where it is. */
  revealCard: (id: string) => void;
  openComposer: (draft: ComposerDraft) => void;
  /** Opens the prompt window with `text` as its instruction (empty for a fresh one). */
  openPrompt: (
    draft: Extract<ComposerDraft, { kind: 'prompt' }>,
    nodeId: string,
    text?: string,
  ) => void;
  /** Changes the open prompt window (its verb or chips); a no-op for any other composer. */
  updatePrompt: (
    patch: Partial<Pick<Extract<ComposerDraft, { kind: 'prompt' }>, 'verb' | 'chips'>>,
  ) => void;
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
  revealRequest: null,
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
  revealCard: (id) =>
    set((state) => ({
      focusedId: id,
      revealRequest: { id, nonce: (state.revealRequest?.nonce ?? 0) + 1 },
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
  openPrompt: (draft, nodeId, text = '') =>
    set((state) => ({
      composer: draft,
      focusedId: DRAFT_ID,
      // The previous window's unsent text is not this one's.
      drafts: {
        ...Object.fromEntries(
          Object.entries(state.drafts).filter(
            ([key]) => !key.endsWith(':new') && !key.endsWith(':prompt'),
          ),
        ),
        ...(text === '' ? {} : { [draftKey(nodeId, 'prompt')]: text }),
      },
    })),
  updatePrompt: (patch) =>
    set((state) =>
      state.composer?.kind === 'prompt' ? { composer: { ...state.composer, ...patch } } : state,
    ),
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
      revealRequest: null,
      composer: null,
    }),
}));

/** The id the composer's pseudo-card and its highlight use. */
export const DRAFT_ID = 'draft';

/** Key of a composer's unsent text in the store: per section and per thread (or `new`). */
export function draftKey(nodeId: string, scope: string): string {
  return `${nodeId}:${scope}`;
}
