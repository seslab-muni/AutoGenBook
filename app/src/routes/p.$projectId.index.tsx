import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';

import { outline } from '@/api/queries/outline';
import { projects } from '@/api/queries/projects';
import { StudioLayout } from '@/components/layout/studio-layout';
import { useCallback, useEffect, useState } from 'react';

import { MarginHostContext } from '@/features/editor/margin/margin-host';
import { RightColumn } from '@/features/editor/margin/right-pane';
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
  const { node, copilot, instruction } = ProjectRoute.useSearch();
  const { project: loaderProject } = ProjectRoute.useLoaderData();
  // Re-subscribe (rather than relying on the loader snapshot alone) so a run finishing — which
  // sets/updates `lastRunId` — is reflected here without a full route reload; see `p.$projectId.tsx`.
  const { data: liveProject } = useQuery(projects.detail(projectId));
  const project = liveProject ?? loaderProject;
  const navigate = useNavigate({ from: Route.fullPath });
  useDocumentTitle(project.title);

  const outlineOpen = useOutlineOpen();
  // The slot in the right column the open section portals its margin into.
  const [marginHost, setMarginHost] = useState<HTMLElement | null>(null);
  const { data } = useQuery(outline.flat(projectId));
  const flatNodes = data?.items ?? [];

  // An old `?tab=` link is dropped by the search validation but would stay in the address bar: rewrite
  // the URL once without it.
  const router = useRouter();
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  useEffect(() => {
    const params = new URLSearchParams(searchStr);
    if (!params.has('tab')) return;
    // The router already ignores it (its search state is validated), so a navigation would be a
    // no-op: replace the history entry itself.
    params.delete('tab');
    const rest = params.toString();
    router.history.replace(`${router.state.location.pathname}${rest ? `?${rest}` : ''}`);
  }, [searchStr, router]);

  const initialRewrite = copilot === 'rewrite' ? { instruction: instruction ?? '' } : null;
  const consumeRewrite = useCallback(() => {
    void navigate({
      search: (prev) => {
        const rest = { ...prev };
        delete rest.copilot;
        delete rest.instruction;
        return rest;
      },
      replace: true,
    });
  }, [navigate]);

  // `?copilot=rewrite` is for one section: with none selected nothing would consume it, and it would
  // open on whichever section is picked next (and come back with Back/Forward).
  useEffect(() => {
    if (copilot && !node) consumeRewrite();
  }, [copilot, node, consumeRewrite]);

  function handleSelectNode(nodeId: string | null) {
    void navigate({
      search: (prev) => {
        const rest = { ...prev };
        delete rest.node;
        return nodeId ? { ...rest, node: nodeId } : rest;
      },
    });
  }

  const selectedNode = node ? (flatNodes.find((n) => n.id === node) ?? null) : null;

  return (
    <MarginHostContext.Provider value={marginHost}>
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
            lastRunId={project.lastRunId ?? null}
            flatNodes={flatNodes}
            outlineOpen={outlineOpen}
            onSelectNode={handleSelectNode}
            initialRewrite={initialRewrite}
            onInitialRewriteConsumed={consumeRewrite}
          />
        }
        marginPane={<RightColumn node={selectedNode} onMarginHost={setMarginHost} />}
      />
    </MarginHostContext.Provider>
  );
}
