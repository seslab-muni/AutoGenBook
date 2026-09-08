import type { OutlineNode, Project } from '@/api/types';
import { EmptyState } from '@/components/empty-state';
import { PaneStatusBar } from '@/components/layout/pane-status-bar';
import { PaneToolbar } from '@/components/layout/pane-toolbar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CitationsPanel } from '@/features/editor/components/citations-panel';
import { ReviewPanel } from '@/features/editor/components/review-panel';
import { parseRagCitations } from '@/features/editor/lib/rag-citation';
import { CopilotPanel } from '@/features/runs/components/copilot-panel';

export type CopilotTab = 'copilot' | 'citations' | 'review';

interface CopilotDrawerProps {
  projectId: string;
  project: Project;
  node: OutlineNode | null | undefined;
  tab: CopilotTab;
  onTabChange: (tab: CopilotTab) => void;
  onOpenSource?: (sourceDoc: string) => void;
}

/**
 * The right-hand drawer's tab shell: `copilot` hosts #21's run-triggering
 * quick actions/event log (`CopilotPanel`), `citations`/`review` are bound to
 * the selected node's real `ragCitations`/`reviewerScore`/`reviewerNotes`.
 */
export function CopilotDrawer({
  projectId,
  project,
  node,
  tab,
  onTabChange,
  onOpenSource,
}: CopilotDrawerProps) {
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
        <CopilotPanel projectId={projectId} project={project} selectedNodeId={node?.id ?? null} />
      </TabsContent>

      <TabsContent value="citations" className="min-h-0 overflow-auto">
        {node ? (
          <CitationsPanel
            citations={parseRagCitations(node.ragCitations)}
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
