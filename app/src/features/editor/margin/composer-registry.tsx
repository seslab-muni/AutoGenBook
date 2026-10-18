import type { ComponentType } from 'react';

import { CommentDraftCard } from './comment-draft-card';
import { PromptDraftCard } from './prompt-window';
import type { MarginCardContext } from './card-registry';
import type { ComposerDraft } from './margin-store';
import type { MarginThread } from './threads';

export interface DraftCardProps {
  draft: ComposerDraft;
  ctx: MarginCardContext;
  /** Offset in the card lane; `undefined` before the first layout. */
  top: number | undefined;
  register: (id: string, element: HTMLElement | null) => void;
  /** The text the draft is about, as it stands now (`null` = the whole section). */
  quote: string | null;
  /** Every thread of the section, for what a prompt can fix or address. */
  threads: readonly MarginThread[];
  /** Where the draft's anchor sits in the text now (UTF-16 offsets), `null` for the whole section. */
  range: { start: number; end: number } | null;
}

/**
 * How each kind of draft is rendered as a card. The margin positions every draft from
 * `draft.anchor` alone and renders it through this table: a new kind of draft is one member of
 * `ComposerDraft` and one entry here.
 */
export const COMPOSER_KINDS: {
  [K in ComposerDraft['kind']]: { Card: ComponentType<DraftCardProps> };
} = {
  comment: { Card: CommentDraftCard },
  prompt: { Card: PromptDraftCard },
};
