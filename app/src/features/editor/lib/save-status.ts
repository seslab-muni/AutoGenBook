export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/** True while there's a change the server doesn't have yet — drives the route blocker and the status chip. */
export function isUnsavedStatus(status: SaveStatus): boolean {
  return status === 'dirty' || status === 'saving';
}

export const SAVE_STATUS_LABEL: Record<SaveStatus, string> = {
  idle: 'Saved',
  saved: 'Saved',
  dirty: 'Unsaved',
  saving: 'Saving…',
  error: 'Error saving',
};
