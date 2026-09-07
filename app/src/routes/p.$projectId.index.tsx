import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { BookOpen } from 'lucide-react';

import { projects } from '@/api/queries/projects';
import { EmptyState } from '@/components/empty-state';
import { PaneToolbar } from '@/components/layout/pane-toolbar';
import { StudioLayout } from '@/components/layout/studio-layout';
import { CopilotPanel } from '@/features/runs/components/copilot-panel';
import { OutlinePane } from '@/features/outline/components/outline-pane';
import { useDocumentTitle } from '@/lib/use-document-title';

import { Route as ProjectRoute } from './p.$projectId';

export const Route = createFileRoute('/p/$projectId/')({
  component: StudioPage,
});

function StudioPage() {
  const { projectId } = Route.useParams();
  const { node } = ProjectRoute.useSearch();
  const { project: loaderProject } = ProjectRoute.useLoaderData();
  // Re-subscribe (rather than relying on the loader snapshot alone) so a run finishing — which
  // sets/updates `lastRunId` — is reflected here without a full route reload; see `p.$projectId.tsx`.
  const { data: liveProject } = useQuery(projects.detail(projectId));
  const project = liveProject ?? loaderProject;
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
          <div className="min-h-0 flex-1">
            <CopilotPanel projectId={projectId} project={project} selectedNodeId={node ?? null} />
          </div>
        </>
      }
    />
  );
}
