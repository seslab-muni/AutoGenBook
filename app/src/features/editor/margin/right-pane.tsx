import { PanelRightClose } from 'lucide-react';

import type { OutlineNode } from '@/api/types';
import { EmptyState } from '@/components/empty-state';
import { useRightColumn } from '@/components/layout/use-right-pane';
import { PaneToolbar } from '@/components/layout/pane-toolbar';
import { Button } from '@/components/ui/button';

interface RightColumnProps {
  node: OutlineNode | null;
  /** Receives the slot the open section renders its margin into (null when it is not showing). */
  onMarginHost: (element: HTMLElement | null) => void;
}

/**
 * The studio's right column: the margin workspace. The open section renders its margin into the
 * slot this hands out by portal, because the section owns the comment data and the text geometry.
 */
export function RightColumn({ node, onMarginHost }: RightColumnProps) {
  const { close } = useRightColumn();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneToolbar className="justify-end">
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
      {node ? (
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
