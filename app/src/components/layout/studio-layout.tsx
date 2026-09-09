import { PanelLeftOpen, PanelRightOpen } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { PaneToolbar } from '@/components/layout/pane-toolbar';
import { usePaneResize } from '@/components/layout/use-pane-resize';
import { cn } from '@/lib/utils';
import {
  DEFAULT_OUTLINE_WIDTH,
  MAX_OUTLINE_WIDTH,
  MIN_OUTLINE_WIDTH,
  useCopilotOpen,
  useOutlineOpen,
  useOutlineWidth,
  useUiStore,
} from '@/stores/ui-store';

interface StudioLayoutProps {
  /** Left pane, resizable (`MIN_OUTLINE_WIDTH`–`MAX_OUTLINE_WIDTH`) — fully unmounted while collapsed. */
  outlinePane: ReactNode;
  /** Centre pane — always mounted, expands to fill closed side panes. */
  editorPane: ReactNode;
  /** Right pane (`w-80 lg:w-96`) — fully unmounted while collapsed. */
  copilotPane: ReactNode;
}

/**
 * The three-pane "Structured Architect" workspace: closeable outline and
 * copilot panes flank a centre editor pane that always fills the remaining
 * width. Side panes fully unmount when closed and are restored from buttons
 * in the centre pane's toolbar. Only pane bodies scroll — this container
 * never does.
 */
export function StudioLayout({ outlinePane, editorPane, copilotPane }: StudioLayoutProps) {
  const outlineOpen = useOutlineOpen();
  const copilotOpen = useCopilotOpen();
  const outlineWidth = useOutlineWidth();
  const toggleOutline = useUiStore((state) => state.toggleOutline);
  const toggleCopilot = useUiStore((state) => state.toggleCopilot);
  const setOutlineWidth = useUiStore((state) => state.setOutlineWidth);

  const { handleProps } = usePaneResize({
    width: outlineWidth,
    min: MIN_OUTLINE_WIDTH,
    max: MAX_OUTLINE_WIDTH,
    defaultWidth: DEFAULT_OUTLINE_WIDTH,
    onWidthChange: setOutlineWidth,
  });

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {outlineOpen ? (
        <div
          className={cn(
            'flex shrink-0 flex-col overflow-hidden border-r',
            // At the untouched default width, keep the old responsive w-72/lg:w-80 breakpoint
            // (matching the copilot pane's own w-80/lg:w-96) instead of a flat inline pixel value
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

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
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
            {!copilotOpen ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Show copilot pane"
                onClick={toggleCopilot}
              >
                <PanelRightOpen />
              </Button>
            ) : null}
          </div>
        </PaneToolbar>
        <div className="custom-scrollbar min-h-0 flex-1 overflow-auto">{editorPane}</div>
      </div>

      {copilotOpen ? (
        <div className="flex w-80 shrink-0 flex-col overflow-hidden border-l lg:w-96">
          {copilotPane}
        </div>
      ) : null}
    </div>
  );
}
