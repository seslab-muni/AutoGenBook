import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { BookOpen, Bot } from 'lucide-react';

import { EmptyState } from '@/components/empty-state';
import { PaneStatusBar } from '@/components/layout/pane-status-bar';
import { PaneToolbar } from '@/components/layout/pane-toolbar';
import { StudioLayout } from '@/components/layout/studio-layout';
import { OutlinePane } from '@/features/outline/components/outline-pane';
import { useDocumentTitle } from '@/lib/use-document-title';

import { Route as ProjectRoute } from './p.$projectId';

export const Route = createFileRoute('/p/$projectId/')({
  component: StudioPage,
});

function StudioPage() {
  const { projectId } = Route.useParams();
  const { node } = ProjectRoute.useSearch();
  const { project } = ProjectRoute.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });
  useDocumentTitle(project.title);

  function handleSelectNode(nodeId: string | null) {
    void navigate({
      search: (prev) => {
        const rest = { ...prev };
        delete rest.node;
        return nodeId ? { ...rest, node: nodeId } : rest;
      },
    });
  }

  return (
    <StudioLayout
      outlinePane={
        <OutlinePane
          projectId={projectId}
          maxOutlineLevels={project.maxOutlineLevels}
          selectedNodeId={node ?? null}
          onSelectNode={handleSelectNode}
        />
      }
      editorPane={
        <EmptyState
          icon={BookOpen}
          title="Section editor coming soon"
          description={
            node
              ? `Selected node: ${node}`
              : 'Select a section from the outline pane to start editing.'
          }
        />
      }
      copilotPane={
        <>
          <PaneToolbar>
            <span className="text-xs font-semibold text-foreground">Copilot</span>
          </PaneToolbar>
          <div className="flex-1 overflow-auto">
            <EmptyState
              icon={Bot}
              title="Multi-agent stream coming soon"
              description="Agent logs and citations land alongside the section editor."
            />
          </div>
          <PaneStatusBar>Idle</PaneStatusBar>
        </>
      }
    />
  );
}
