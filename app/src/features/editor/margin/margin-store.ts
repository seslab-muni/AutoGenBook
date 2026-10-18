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
      /**
       * The review issues / comments the original request was about (Try again): kept as they were
       * asked, so editing the instruction does not widen "fix this issue" to every open one.
       * `undefined` = whatever is open in the window's scope.
       */
      fixIssueIds?: string[] | undefined;
      addressCommentIds?: string[] | undefined;
      /** Where this prompt's unsent text and options are kept (`promptKey`): one per scope. */
      key: string;
      /** Shown under the scope pill: why the window is not what the person asked for (a selection that is gone). */
      notice?: string | undefined;
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
  /** Options and verb of every prompt draft (by `promptKey`), so a closed or replaced draft keeps them. */
  promptExtras: Record<string, { verb: 'revise' | 'rewrite'; chips: PromptChips }>;
  /** A section's unfinished composer, kept while another section is open and restored when it comes back. */
  savedComposers: Record<string, ComposerDraft>;
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
  /**
   * Opens the prompt window for this section and scope. With `explicit` (Try again, a pre-set
   * request) the draft's own verb, options and `text` are used; otherwise whatever was kept for that
   * scope is reused (text in `drafts`, options in `promptExtras`), so reopening never loses what was typed.
   */
  openPrompt: (
    draft: Omit<Extract<ComposerDraft, { kind: 'prompt' }>, 'key'>,
    nodeId: string,
    options?: { text?: string; explicit?: boolean },
  ) => void;
  /** Brings back the composer this section was left with. */
  restoreComposer: (nodeId: string) => void;
  /** Changes the open prompt window (its verb or chips); a no-op for any other composer. */
  updatePrompt: (
    patch: Partial<Pick<Extract<ComposerDraft, { kind: 'prompt' }>, 'verb' | 'chips'>>,
  ) => void;
  closeComposer: () => void;
  /** Forgets the verb and options kept for a prompt scope (the window was cancelled on purpose). */
  forgetPromptExtras: (key: string) => void;
  reset: (nodeId?: string) => void;
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
  promptExtras: {},
  savedComposers: {},
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
  openPrompt: (draft, nodeId, { text, explicit = false } = {}) =>
    set((state) => {
      const key = promptKey(draft.anchor);
      const kept = state.promptExtras[key];
      const verb = explicit || !kept ? draft.verb : kept.verb;
      const chips = explicit || !kept ? draft.chips : kept.chips;
      return {
        composer: { ...draft, verb, chips, key },
        focusedId: DRAFT_ID,
        promptExtras: { ...state.promptExtras, [key]: { verb, chips } },
        // Unsent text is never thrown away by opening a window: only an explicit request replaces it.
        drafts:
          text !== undefined && (explicit || text !== '')
            ? { ...state.drafts, [draftKey(nodeId, key)]: text }
            : state.drafts,
      };
    }),
  updatePrompt: (patch) =>
    set((state) => {
      if (state.composer?.kind !== 'prompt') return state;
      const composer = { ...state.composer, ...patch };
      return {
        composer,
        promptExtras: {
          ...state.promptExtras,
          [composer.key]: { verb: composer.verb, chips: composer.chips },
        },
      };
    }),
  restoreComposer: (nodeId) =>
    set((state) => {
      const saved = state.savedComposers[nodeId];
      if (!saved || state.composer) return state;
      const { [nodeId]: _used, ...rest } = state.savedComposers;
      void _used;
      return { composer: saved, focusedId: DRAFT_ID, savedComposers: rest };
    }),
  forgetPromptExtras: (key) =>
    set((state) => {
      if (!(key in state.promptExtras)) return state;
      const { [key]: _removed, ...rest } = state.promptExtras;
      void _removed;
      return { promptExtras: rest };
    }),
  closeComposer: () =>
    set((state) => ({
      composer: null,
      focusedId: state.focusedId === DRAFT_ID ? null : state.focusedId,
    })),
  reset: (nodeId) =>
    set((state) => {
      const keep =
        nodeId &&
        state.composer &&
        (state.composer.kind === 'prompt' ||
          (state.drafts[draftKey(nodeId, 'new')] ?? '').trim() !== '');
      return {
        filter: 'all',
        showResolved: false,
        focusedId: null,
        focusRequest: null,
        revealRequest: null,
        composer: null,
        ...(keep && nodeId && state.composer
          ? { savedComposers: { ...state.savedComposers, [nodeId]: state.composer } }
          : {}),
      };
    }),
}));

/** Where a prompt's unsent text and options live: one per scope (the section, or one selected range). */
export function promptKey(anchor: { start: number | null; end: number | null } | null): string {
  return anchor ? `prompt:range:${anchor.start ?? 'x'}-${anchor.end ?? 'x'}` : 'prompt:section';
}

/** The id the composer's pseudo-card and its highlight use. */
export const DRAFT_ID = 'draft';

/** Key of a composer's unsent text in the store: per section and per thread (or `new`). */
export function draftKey(nodeId: string, scope: string): string {
  return `${nodeId}:${scope}`;
}
