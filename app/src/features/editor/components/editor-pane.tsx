import { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpen } from 'lucide-react';

import { outline } from '@/api/queries/outline';
import type { OutlineNode } from '@/api/types';
import { EmptyState } from '@/components/empty-state';
import { PaneToolbar } from '@/components/layout/pane-toolbar';
import { Skeleton } from '@/components/ui/skeleton';
import { SectionJumpSelect } from '@/features/editor/components/section-jump-select';

// `ManuscriptSheet` pulls in `react-markdown`/remark/rehype/KaTeX and CodeMirror — loaded only once
// a section is actually selected, as its own chunk (see the PR description for its build size).
const ManuscriptSheet = lazy(() =>
  import('@/features/editor/components/manuscript-sheet').then((m) => ({
    default: m.ManuscriptSheet,
  })),
);

interface EditorPaneProps {
  projectId: string;
  nodeId: string | null;
  projectTitle: string;
  lastRunId?: string | null;
  flatNodes: readonly OutlineNode[];
  outlineOpen: boolean;
  onSelectNode: (nodeId: string) => void;
}

/**
 * Always-mounted centre pane shell: fetches the full selected node (the
 * flat outline list may omit heavy fields — `getOutlineNode`'s spec note),
 * and lazily renders `ManuscriptSheet` once it's loaded. Kept separate from
 * `ManuscriptSheet` so the empty/loading states never pull in its heavy
 * dependencies.
 */
export function EditorPane({
  projectId,
  nodeId,
  projectTitle,
  lastRunId = null,
  flatNodes,
  outlineOpen,
  onSelectNode,
}: EditorPaneProps) {
  const nodeQuery = useQuery({
    ...outline.node(projectId, nodeId ?? ''),
    enabled: nodeId !== null,
  });

  if (!nodeId) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {!outlineOpen && flatNodes.length > 0 ? (
          <PaneToolbar>
            <SectionJumpSelect flat={flatNodes} selectedNodeId={null} onSelectNode={onSelectNode} />
          </PaneToolbar>
        ) : null}
        <div className="min-h-0 flex-1">
          <EmptyState
            icon={BookOpen}
            title="No section selected"
            description="Select a chapter or section from the outline to inspect and write."
          />
        </div>
      </div>
    );
  }

  if (nodeQuery.isPending) {
    return (
      <div className="flex h-full flex-col gap-3 p-4">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-full w-full" />
      </div>
    );
  }

  if (nodeQuery.isError || !nodeQuery.data) {
    return (
      <EmptyState
        title="Couldn't load this section"
        description="It may have been deleted, or moved by another edit."
      />
    );
  }

  return (
    <Suspense
      fallback={
        <div className="flex h-full flex-col gap-3 p-4">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-full w-full" />
        </div>
      }
    >
      <ManuscriptSheet
        key={nodeQuery.data.id}
        projectId={projectId}
        node={nodeQuery.data}
        projectTitle={projectTitle}
        lastRunId={lastRunId}
        flatNodes={flatNodes}
        outlineOpen={outlineOpen}
        onSelectNode={onSelectNode}
      />
    </Suspense>
  );
}
