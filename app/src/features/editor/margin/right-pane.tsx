import { PanelRightClose } from 'lucide-react';

import type { OutlineNode, Project } from '@/api/types';
import { EmptyState } from '@/components/empty-state';
import { useRightColumn } from '@/components/layout/use-right-pane';
import { PaneToolbar } from '@/components/layout/pane-toolbar';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { CopilotDrawer, type CopilotTab } from '@/features/editor/components/copilot-drawer';
import { useUiStore, useRightPaneMode, type RightPane } from '@/stores/ui-store';

interface RightColumnProps {
  projectId: string;
  project: Project;
  node: OutlineNode | null;
  tab: CopilotTab;
  onTabChange: (tab: CopilotTab) => void;
  /** Receives the slot the open section renders its margin into (null when it is not showing). */
  onMarginHost: (element: HTMLElement | null) => void;
}

/**
 * The studio's right column: the margin workspace by default, with a switch to the legacy copilot
 * drawer (Copilot + Review tabs) that stays until phase 4 / 3 replace what is left in it. Removing
 * the legacy drawer later means deleting the switch, the `copilot` branch and `CopilotDrawer`.
 */
export function RightColumn({
  projectId,
  project,
  node,
  tab,
  onTabChange,
  onMarginHost,
}: RightColumnProps) {
  const mode = useRightPaneMode();
  const setMode = useUiStore((state) => state.setRightPane);
  const { close } = useRightColumn();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneToolbar>
        <ToggleGroup
          aria-label="Right pane"
          value={mode}
          onValueChange={(value) => setMode(value as RightPane)}
        >
          <ToggleGroupItem value="margin">Margin</ToggleGroupItem>
          <ToggleGroupItem value="copilot">Copilot</ToggleGroupItem>
        </ToggleGroup>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close right pane"
          onClick={close}
        >
          <PanelRightClose />
        </Button>
      </PaneToolbar>
      {mode === 'copilot' ? (
        <div className="min-h-0 flex-1">
          <CopilotDrawer
            projectId={projectId}
            project={project}
            node={node}
            tab={tab}
            onTabChange={onTabChange}
          />
        </div>
      ) : node ? (
        <div ref={onMarginHost} className="min-h-0 flex-1" />
      ) : (
        <EmptyState
          title="No section selected"
          description="Select a section to see its comments."
        />
      )}
    </div>
  );
}
