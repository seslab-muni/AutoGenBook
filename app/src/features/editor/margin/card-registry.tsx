import type { ComponentType } from 'react';
import { Bot, ClipboardCheck, MessageSquare, type LucideIcon } from 'lucide-react';

import type { CommentKind } from '@/api/types';
import { CommentCardBody } from './comment-card-body';
import { ReadOnlyCardBody } from './read-only-card-body';
import type { MarginThread } from './threads';

/** What every card part can use besides its thread. */
export interface MarginCardContext {
  projectId: string;
  nodeId: string;
  /** The signed-in user, to tell which messages are theirs to edit or delete. */
  currentUserId: string | null;
  /** Shows the copilot's actions (`Send to Copilot`); see `flags.ts`. */
  copilotActions: boolean;
  /** Puts keyboard focus back in the text after a composer closes. */
  restoreEditorFocus: () => void;
  /**
   * Replaces the open editor's text with `markdown`, which is what the server now holds (for
   * instance after accepting a suggestion that rewrote the section). Cancels a pending autosave
   * so the old draft cannot overwrite it, and re-resolves every anchor against the new text.
   */
  applyServerContent: (markdown: string) => void;
  /** True while the editor holds edits the server has not seen (an Accept should warn instead of clobbering them). */
  hasUnsavedEdits: () => boolean;
  /**
   * Saves what is pending and resolves once nothing is pending or in flight (immediately when there
   * is nothing). Rejects if the save fails, or while saving is on hold for an unresolved conflict
   * with a change from elsewhere. An Accept awaits this before asking the server to rewrite the text.
   */
  flushEdits: () => Promise<void>;
  /**
   * `Send to Copilot` on a thread (phase 4). The button renders only when the copilot flag is on
   * *and* this is supplied, so flipping the flag can never ship a dead button.
   */
  onSendToCopilot?: ((thread: MarginThread) => void) | undefined;
}

export interface MarginCardPartProps {
  thread: MarginThread;
  ctx: MarginCardContext;
  /** The anchor has no rendered highlight in the current view: its card sits by the nearest block. */
  approximate?: boolean;
}
/** Kept for the card bodies written before the slots existed. */
export type MarginCardBodyProps = MarginCardPartProps;

export interface MarginCardKind {
  /** Heading of the card ("Comment"). */
  label: string;
  icon: LucideIcon;
  /**
   * Header's right-hand side. Default: the Orphaned / Whole section / Resolved badges. A suggestion
   * card puts its running / pending / failed state here, a review card its severity and type pills.
   */
  Status?: ComponentType<MarginCardPartProps>;
  /**
   * What the card says it is about. Default: the quoted text. A suggestion card replaces it with
   * its diff; return `null` for nothing.
   */
  Quote?: ComponentType<MarginCardPartProps>;
  /** Everything under the header and the quote. */
  Body: ComponentType<MarginCardPartProps>;
}

/**
 * One entry per `kind` of margin row. `MarginCard` is the shared frame (position, focus, header,
 * quote); the `Status`, `Quote` and `Body` slots are what differ. Phase 3 replaces `review`
 * (severity/type pills in `Status`, required fix in `Body`, Fix with Copilot / Dismiss), phase 4
 * replaces `suggestion` (progress states in `Status`, the diff in `Quote`, Accept / Reject /
 * Try again in `Body`): swap the entry here, nothing else changes. Until then those kinds render
 * read-only rather than disappearing.
 */
export const MARGIN_CARD_KINDS: Record<CommentKind, MarginCardKind> = {
  comment: { label: 'Comment', icon: MessageSquare, Body: CommentCardBody },
  suggestion: { label: 'Suggestion', icon: Bot, Body: ReadOnlyCardBody },
  review: { label: 'Review', icon: ClipboardCheck, Body: ReadOnlyCardBody },
};

export function cardKind(kind: string): MarginCardKind {
  return (
    MARGIN_CARD_KINDS[kind as CommentKind] ?? {
      label: 'Note',
      icon: MessageSquare,
      Body: ReadOnlyCardBody,
    }
  );
}
