import type { ComponentType } from 'react';
import { Bot, ClipboardCheck, MessageSquare, type LucideIcon } from 'lucide-react';

import type { CommentKind } from '@/api/types';
import { CommentCardBody } from './comment-card-body';
import { ReadOnlyCardBody } from './read-only-card-body';
import type { MarginThread } from './threads';

/** What every card body can use besides its thread. */
export interface MarginCardContext {
  projectId: string;
  nodeId: string;
  /** The signed-in user, to tell which messages are theirs to edit or delete. */
  currentUserId: string | null;
  /** Shows the copilot's actions (`Send to Copilot`); see `flags.ts`. */
  copilotActions: boolean;
  /** Puts keyboard focus back in the text after a composer closes. */
  restoreEditorFocus: () => void;
}

export interface MarginCardBodyProps {
  thread: MarginThread;
  ctx: MarginCardContext;
}

export interface MarginCardKind {
  /** Heading of the card ("Comment"). */
  label: string;
  icon: LucideIcon;
  /** Renders everything under the card's header and quote. */
  Body: ComponentType<MarginCardBodyProps>;
}

/**
 * One entry per `kind` of margin row. `MarginCard` is the shared frame (position, focus,
 * header, quote); the body is what differs. Phase 3 replaces `review` with the reviewer card
 * (severity pills, required fix, Dismiss), phase 4 replaces `suggestion` with the diff card
 * (Accept / Reject / Try again): swap the `Body` here, nothing else changes. Until then those
 * kinds render read-only rather than disappearing.
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
