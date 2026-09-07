import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { BookOpen, Bot, ListTree } from 'lucide-react';

import { outline } from '@/api/queries/outline';
import { EmptyState } from '@/components/empty-state';
import { PaneStatusBar } from '@/components/layout/pane-status-bar';
import { PaneToolbar } from '@/components/layout/pane-toolbar';
import { StudioLayout } from '@/components/layout/studio-layout';
import { useDocumentTitle } from '@/lib/use-document-title';

import { Route as ProjectRoute } from './p.$projectId';

export const Route = createFileRoute('/p/$projectId/')({
  component: StudioPage,
});

function StudioPage() {
  const { projectId } = Route.useParams();
  const { node } = ProjectRoute.useSearch();
  const { project } = ProjectRoute.useLoaderData();
  const { data: outlineNodes } = useQuery(outline.flat(projectId));
  useDocumentTitle(project.title);

  return (
    <StudioLayout
      outlinePane={
        <>
          <PaneToolbar>
            <span className="text-xs font-semibold text-foreground">Outline</span>
          </PaneToolbar>
          <div className="flex-1 overflow-auto">
            <EmptyState
              icon={ListTree}
              title="Outline tree coming soon"
              description="Browsing and editing the outline lands in issue #19."
            />
          </div>
          <PaneStatusBar>{outlineNodes?.total ?? 0} nodes</PaneStatusBar>
        </>
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
