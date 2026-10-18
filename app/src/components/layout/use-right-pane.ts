import { useMediaQuery } from '@/lib/use-media-query';
import { useUiStore } from '@/stores/ui-store';

/** Wide enough for outline + editor + the 376px margin side by side. */
export const WIDE_QUERY = '(min-width: 1280px)';

/**
 * Open state of the studio's right column. Wide screens keep it beside the editor (the persisted
 * `marginOpen`); narrower ones float it over the editor's right edge as a side sheet
 * (`rightOverlayOpen`, never persisted: opening it on a narrow screen must not change the
 * wide-screen preference, and a reload must not start with the editor covered).
 */
export function useRightColumn() {
  const wide = useMediaQuery(WIDE_QUERY);
  const persisted = useUiStore((state) => state.marginOpen);
  const overlay = useUiStore((state) => state.rightOverlayOpen);
  return {
    wide,
    open: wide ? persisted : overlay,
    toggle: () => {
      const state = useUiStore.getState();
      if (wide) state.toggleMargin();
      else state.setRightOverlayOpen(!state.rightOverlayOpen);
    },
    close: () => {
      const state = useUiStore.getState();
      if (wide) useUiStore.setState({ marginOpen: false });
      else state.setRightOverlayOpen(false);
    },
    /** Shows the margin, whatever the screen width. */
    revealMargin: () => {
      const state = useUiStore.getState();
      if (wide) useUiStore.setState({ marginOpen: true });
      else state.setRightOverlayOpen(true);
    },
  };
}
