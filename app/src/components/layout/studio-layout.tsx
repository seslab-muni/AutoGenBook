import { PanelLeftOpen, PanelRightOpen } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { PaneToolbar } from '@/components/layout/pane-toolbar';
import { usePaneResize } from '@/components/layout/use-pane-resize';
import { useRightColumn } from '@/components/layout/use-right-pane';
import { cn } from '@/lib/utils';
import {
  DEFAULT_MARGIN_WIDTH,
  DEFAULT_OUTLINE_WIDTH,
  MAX_MARGIN_WIDTH,
  MAX_OUTLINE_WIDTH,
  MIN_MARGIN_WIDTH,
  MIN_OUTLINE_WIDTH,
  useMarginWidth,
  useOutlineOpen,
  useOutlineWidth,
  useUiStore,
} from '@/stores/ui-store';

interface StudioLayoutProps {
  /** Left pane, resizable (`MIN_OUTLINE_WIDTH`–`MAX_OUTLINE_WIDTH`) — fully unmounted while collapsed. */
  outlinePane: ReactNode;
  /** Centre pane — always mounted, expands to fill closed side panes. */
  editorPane: ReactNode;
  /**
   * Right pane (the margin workspace, 376px by default, resizable `MIN_MARGIN_WIDTH`–`MAX_MARGIN_WIDTH`
   * by the handle on its left edge) — fully unmounted while collapsed. Below 1280px it floats over
   * the editor's right edge at the default width instead of squeezing it.
   */
  marginPane: ReactNode;
}

/**
 * The three-pane "Structured Architect" workspace: closeable outline and
 * margin panes flank a centre editor pane that always fills the remaining
 * width. Side panes fully unmount when closed and are restored from buttons
 * in the centre pane's toolbar. Only pane bodies scroll — this container
 * never does.
 */
/** Width of the side sheet (the right column below 1280px, which is not resizable). */
const PANEL_WIDTH = DEFAULT_MARGIN_WIDTH;

export function StudioLayout({ outlinePane, editorPane, marginPane }: StudioLayoutProps) {
  const outlineOpen = useOutlineOpen();
  const { wide, open: marginOpen, toggle: toggleRight, close: closeRight } = useRightColumn();
  const outlineWidth = useOutlineWidth();
  const marginWidth = useMarginWidth();
  const toggleOutline = useUiStore((state) => state.toggleOutline);
  const setOutlineWidth = useUiStore((state) => state.setOutlineWidth);
  const setMarginWidth = useUiStore((state) => state.setMarginWidth);
  const overlay = !wide && marginOpen;
  const panelRef = useRef<HTMLDivElement>(null);

  // Below 1280px the right column is a non-modal side sheet: it closes on a press outside it and on
  // Escape from anywhere (the editor included), and the editor pane makes room for it, below.
  useEffect(() => {
    if (!overlay) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || panelRef.current?.contains(target)) return;
      // Dialogs, menus and toasts the sheet's own cards open live in portals outside it; the
      // copilot's entry points (the header button, the selection bar) open the sheet themselves, and
      // closing it first would move the editor under the pointer and lose the click.
      if (
        target.closest(
          '[role="alertdialog"], [role="dialog"], [role="menu"], [data-sonner-toaster], [data-copilot-trigger], [role="toolbar"][aria-label="Selection actions"]',
        )
      ) {
        return;
      }
      closeRight();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // The editor's own Escape handler marks the event as handled, so that cannot be the test; a
      // composer in the sheet stops the event itself, and an open dialog/menu owns this Escape.
      if (event.key !== 'Escape') return;
      if (document.querySelector('[role="alertdialog"], [role="dialog"], [role="menu"]')) return;
      closeRight();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [overlay, closeRight]);

  const { handleProps } = usePaneResize({
    width: outlineWidth,
    min: MIN_OUTLINE_WIDTH,
    max: MAX_OUTLINE_WIDTH,
    defaultWidth: DEFAULT_OUTLINE_WIDTH,
    onWidthChange: setOutlineWidth,
  });
  const { handleProps: rightHandleProps } = usePaneResize({
    width: marginWidth,
    min: MIN_MARGIN_WIDTH,
    max: MAX_MARGIN_WIDTH,
    defaultWidth: DEFAULT_MARGIN_WIDTH,
    onWidthChange: setMarginWidth,
    direction: 'left',
  });

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {outlineOpen ? (
        <div
          className={cn(
            'flex shrink-0 flex-col overflow-hidden border-r',
            // At the untouched default width, keep the old responsive w-72/lg:w-80 breakpoint
            // (matching the right pane's own w-80/lg:w-96) instead of a flat inline pixel value
            // that doesn't scale down on narrow viewports; a genuinely custom width (drag, or
            // keyboard resize) switches to the fixed inline value below.
            outlineWidth === DEFAULT_OUTLINE_WIDTH && 'w-72 lg:w-80',
          )}
          style={outlineWidth === DEFAULT_OUTLINE_WIDTH ? undefined : { width: outlineWidth }}
        >
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{outlinePane}</div>
            <div
              {...handleProps}
              aria-label="Resize outline pane"
              className={cn(
                'w-1 shrink-0 cursor-col-resize touch-none bg-transparent',
                'hover:bg-ring/50 focus-visible:bg-ring focus-visible:outline-none',
              )}
            />
          </div>
        </div>
      ) : null}

      <div
        className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background"
        // Leave the side sheet's width free so the text being commented on is not covered by it.
        style={overlay ? { paddingRight: PANEL_WIDTH } : undefined}
      >
        <PaneToolbar>
          <div className="flex items-center gap-1">
            {!outlineOpen ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Show outline pane"
                onClick={toggleOutline}
              >
                <PanelLeftOpen />
              </Button>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            {!marginOpen ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Show right pane"
                onClick={toggleRight}
              >
                <PanelRightOpen />
              </Button>
            ) : null}
          </div>
        </PaneToolbar>
        <div className="custom-scrollbar min-h-0 flex-1 overflow-auto">{editorPane}</div>
      </div>

      {marginOpen ? (
        <div
          ref={panelRef}
          className={cn(
            'flex shrink-0 overflow-hidden border-l bg-background',
            wide
              ? marginWidth === DEFAULT_MARGIN_WIDTH && 'w-[376px]'
              : 'absolute inset-y-0 right-0 z-20 w-[376px] shadow-2xl',
          )}
          style={wide && marginWidth !== DEFAULT_MARGIN_WIDTH ? { width: marginWidth } : undefined}
        >
          {wide ? (
            <div
              {...rightHandleProps}
              aria-label="Resize right pane"
              className={cn(
                'w-1 shrink-0 cursor-col-resize touch-none bg-transparent',
                'hover:bg-ring/50 focus-visible:bg-ring focus-visible:outline-none',
              )}
            />
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{marginPane}</div>
        </div>
      ) : null}
    </div>
  );
}
