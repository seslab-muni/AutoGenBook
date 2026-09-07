import { Bot } from 'lucide-react';

import type { OutlineNode } from '@/api/types';
import { EmptyState } from '@/components/empty-state';
import { PaneStatusBar } from '@/components/layout/pane-status-bar';
import { PaneToolbar } from '@/components/layout/pane-toolbar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CitationsPanel } from '@/features/editor/components/citations-panel';
import { ReviewPanel } from '@/features/editor/components/review-panel';

export type CopilotTab = 'copilot' | 'citations' | 'review';

interface CopilotDrawerProps {
  node: OutlineNode | null | undefined;
  tab: CopilotTab;
  onTabChange: (tab: CopilotTab) => void;
  onOpenSource?: (sourceDoc: string) => void;
}

/**
 * The right-hand drawer's tab shell. The `copilot` tab is #21's territory
 * (run-triggering quick actions over SSE) — left as the existing placeholder
 * here; this only wires up `citations`/`review`, bound to the selected
 * node's real `ragCitations`/`reviewerScore`/`reviewerNotes`.
 */
export function CopilotDrawer({ node, tab, onTabChange, onOpenSource }: CopilotDrawerProps) {
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTabChange(value as CopilotTab)}
      className="flex h-full min-h-0 flex-col"
    >
      <PaneToolbar className="justify-start">
        <TabsList>
          <TabsTrigger value="copilot">Copilot</TabsTrigger>
          <TabsTrigger value="citations">Citations</TabsTrigger>
          <TabsTrigger value="review">Review</TabsTrigger>
        </TabsList>
      </PaneToolbar>

      <TabsContent value="copilot" className="min-h-0 overflow-auto">
        <EmptyState
          icon={Bot}
          title="Multi-agent stream coming soon"
          description="Agent logs and quick actions land here in issue #21."
        />
      </TabsContent>

      <TabsContent value="citations" className="min-h-0 overflow-auto">
        {node ? (
          <CitationsPanel
            citations={node.ragCitations}
            {...(onOpenSource ? { onOpenSource } : {})}
          />
        ) : (
          <EmptyState
            title="No section selected"
            description="Select a section to see its citations."
          />
        )}
      </TabsContent>

      <TabsContent value="review" className="min-h-0 overflow-auto">
        {node ? (
          <ReviewPanel reviewerScore={node.reviewerScore} reviewerNotes={node.reviewerNotes} />
        ) : (
          <EmptyState
            title="No section selected"
            description="Select a section to see its review."
          />
        )}
      </TabsContent>

      <PaneStatusBar>{node ? `§${node.sectionNumber} ${node.title}` : 'Idle'}</PaneStatusBar>
    </Tabs>
  );
}
