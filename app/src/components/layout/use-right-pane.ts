import { useMediaQuery } from '@/lib/use-media-query';
import { useUiStore } from '@/stores/ui-store';

/** Wide enough for outline + editor + the 376px margin side by side. */
export const WIDE_QUERY = '(min-width: 1280px)';

/**
 * Open state of the studio's right column. Wide screens keep it beside the editor (the persisted
 * `copilotOpen`); narrower ones float it over the editor's right edge (`rightOverlayOpen`, never
 * persisted, so a reload does not start with the editor covered).
 */
export function useRightPane() {
  const wide = useMediaQuery(WIDE_QUERY);
  const persisted = useUiStore((state) => state.copilotOpen);
  const overlay = useUiStore((state) => state.rightOverlayOpen);
  const toggleCopilot = useUiStore((state) => state.toggleCopilot);
  const setOverlayOpen = useUiStore((state) => state.setRightOverlayOpen);
  return {
    wide,
    open: wide ? persisted : overlay,
    toggle: () => (wide ? toggleCopilot() : setOverlayOpen(!overlay)),
    close: () => (wide ? useUiStore.setState({ copilotOpen: false }) : setOverlayOpen(false)),
  };
}
