import type { ComponentType } from 'react';

import { CommentDraftCard } from './comment-draft-card';
import type { MarginCardContext } from './card-registry';
import type { ComposerDraft } from './margin-store';

export interface DraftCardProps {
  draft: ComposerDraft;
  ctx: MarginCardContext;
  /** Offset in the card lane; `undefined` before the first layout. */
  top: number | undefined;
  register: (id: string, element: HTMLElement | null) => void;
  /** The text the draft is about, as it stands now (`null` = the whole section). */
  quote: string | null;
}

/**
 * How each kind of draft is rendered as a card. The margin positions every draft from
 * `draft.anchor` alone and renders it through this table, so the prompt window (phase 4) adds a
 * `prompt` entry here (and a member to `ComposerDraft`) without touching the panel.
 */
export const COMPOSER_KINDS: {
  [K in ComposerDraft['kind']]: { Card: ComponentType<DraftCardProps> };
} = {
  comment: { Card: CommentDraftCard },
};
