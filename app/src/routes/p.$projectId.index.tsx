import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';

import { outline } from '@/api/queries/outline';
import { projects } from '@/api/queries/projects';
import { StudioLayout } from '@/components/layout/studio-layout';
import { CopilotDrawer, type CopilotTab } from '@/features/editor/components/copilot-drawer';
import { EditorPane } from '@/features/editor/components/editor-pane';
import { OutlinePane } from '@/features/outline/components/outline-pane';
import { useOutlineOpen } from '@/stores/ui-store';
import { useDocumentTitle } from '@/lib/use-document-title';

import { Route as ProjectRoute } from './p.$projectId';

export const Route = createFileRoute('/p/$projectId/')({
  component: StudioPage,
});

function StudioPage() {
  const { projectId } = Route.useParams();
  const { node, tab } = ProjectRoute.useSearch();
  const { project: loaderProject } = ProjectRoute.useLoaderData();
  // Re-subscribe (rather than relying on the loader snapshot alone) so a run finishing — which
  // sets/updates `lastRunId` — is reflected here without a full route reload; see `p.$projectId.tsx`.
  const { data: liveProject } = useQuery(projects.detail(projectId));
  const project = liveProject ?? loaderProject;
  const navigate = useNavigate({ from: Route.fullPath });
  useDocumentTitle(project.title);

  const outlineOpen = useOutlineOpen();
  const { data } = useQuery(outline.flat(projectId));
  const flatNodes = data?.items ?? [];

  function handleSelectNode(nodeId: string | null) {
    void navigate({
      search: (prev) => {
        const rest = { ...prev };
        delete rest.node;
        return nodeId ? { ...rest, node: nodeId } : rest;
      },
    });
  }

  function handleTabChange(nextTab: CopilotTab) {
    void navigate({ search: (prev) => ({ ...prev, tab: nextTab }) });
  }

  const selectedNode = node ? (flatNodes.find((n) => n.id === node) ?? null) : null;

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
        <EditorPane
          projectId={projectId}
          nodeId={node ?? null}
          projectTitle={project.title}
          lastRunId={project.lastRunId}
          flatNodes={flatNodes}
          outlineOpen={outlineOpen}
          onSelectNode={handleSelectNode}
        />
      }
      copilotPane={
        <CopilotDrawer
          projectId={projectId}
          project={project}
          node={selectedNode}
          tab={tab === 'settings' ? 'copilot' : (tab ?? 'copilot')}
          onTabChange={handleTabChange}
        />
      }
    />
  );
}
