import type { OutlineNode } from '@/api/types';
import { isLeaf } from '@/features/outline/model';

/**
 * Content locks (issue #113): a locked leaf's `contentMarkdown` is kept byte-for-byte by the
 * next full run (never handed to the writer) while still being fed into the cross-section
 * context, so the sections generated after it stop re-covering it. Distinct from
 * `structureLocked`, which only says whether the CLI may *split* a node.
 *
 * Shared by the outline row, the properties sheet, the Copilot panel and the start-run dialog so
 * the wording and the "when can this be locked" rule stay identical everywhere.
 */

export const CONTENT_LOCK_NEEDS_CONTENT_MESSAGE =
  'Write the section first — only sections with content can be locked.';
export const CONTENT_LOCK_LEAF_ONLY_MESSAGE =
  'Only leaf sections can be locked — lock the sections below it instead.';
export const CONTENT_LOCKED_BADGE_LABEL =
  'Content locked — kept as-is on the next run and used as context for the sections after it.';
export const ADD_UNDER_LOCKED_MESSAGE =
  "Unlock this section's content before adding sections under it.";
export const LOCK_CONTENT_LABEL = 'Lock content — keep as-is on the next run';
export const UNLOCK_CONTENT_LABEL = 'Unlock content';

/**
 * Why `node` cannot be locked right now, or `undefined` when it can (or already is — unlocking is
 * always allowed). Mirrors the API's rules (`OutlineService._normalize_content_lock`): 409 on a
 * node with children, 422 on blank content.
 */
export function contentLockDisabledReason(
  node: OutlineNode,
  flat: readonly OutlineNode[],
): string | undefined {
  if (node.contentLocked) return undefined;
  if (!isLeaf(node.id, flat)) return CONTENT_LOCK_LEAF_ONLY_MESSAGE;
  if (node.contentMarkdown.trim().length === 0) return CONTENT_LOCK_NEEDS_CONTENT_MESSAGE;
  return undefined;
}

export function contentLockToggleLabel(node: OutlineNode): string {
  return node.contentLocked ? UNLOCK_CONTENT_LABEL : LOCK_CONTENT_LABEL;
}

export function lockedNodes(flat: readonly OutlineNode[]): OutlineNode[] {
  return flat.filter((node) => node.contentLocked);
}
