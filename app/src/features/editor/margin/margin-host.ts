import { createContext, useContext } from 'react';

/**
 * The element in the studio's right column that the open section renders its margin into
 * (a portal), or `null` while the column shows something else or is closed. The sheet owns the
 * comment data and the text geometry; the column only provides the slot.
 */
export const MarginHostContext = createContext<HTMLElement | null>(null);

export function useMarginHost(): HTMLElement | null {
  return useContext(MarginHostContext);
}
