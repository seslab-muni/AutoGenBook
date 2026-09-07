import { PanelLeftOpen, PanelRightOpen } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { PaneToolbar } from '@/components/layout/pane-toolbar';
import { useOutlineOpen, useCopilotOpen, useUiStore } from '@/stores/ui-store';

interface StudioLayoutProps {
  /** Left pane (`w-72 lg:w-80`) — fully unmounted while collapsed. */
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
  const toggleOutline = useUiStore((state) => state.toggleOutline);
  const toggleCopilot = useUiStore((state) => state.toggleCopilot);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {outlineOpen ? (
        <div className="flex w-72 shrink-0 flex-col overflow-hidden border-r lg:w-80">
          {outlinePane}
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
        <div className="min-h-0 flex-1 overflow-auto">{editorPane}</div>
      </div>

      {copilotOpen ? (
        <div className="flex w-80 shrink-0 flex-col overflow-hidden border-l lg:w-96">
          {copilotPane}
        </div>
      ) : null}
    </div>
  );
}
