import { useQuery } from '@tanstack/react-query';
import { createFileRoute, notFound, Outlet } from '@tanstack/react-router';

import { outline } from '@/api/queries/outline';
import { projects } from '@/api/queries/projects';
import { ApiError } from '@/api/client';
import { requireAuth } from '@/auth/require-auth';
import { AppHeader } from '@/components/layout/app-header';
import { NotFoundView } from '@/components/layout/not-found-view';
import { Skeleton } from '@/components/ui/skeleton';
import { ProjectSettingsDialog } from '@/features/projects/components/project-settings-dialog';
import { ExportDialog } from '@/features/exports/components/export-dialog';
import { useActiveRun } from '@/features/runs/hooks/use-active-run';
import { RunsPanel } from '@/features/runs/components/runs-panel';
import { StartRunDialog } from '@/features/runs/components/start-run-dialog';
import { SourcesDialog } from '@/features/sources/components/sources-dialog';

export interface ProjectSearch {
  node?: string;
  tab?: 'copilot' | 'citations' | 'review' | 'settings';
}

type ProjectTab = NonNullable<ProjectSearch['tab']>;
const TABS: readonly ProjectTab[] = ['copilot', 'citations', 'review', 'settings'];

function validateSearch(search: Record<string, unknown>): ProjectSearch {
  const result: ProjectSearch = {};
  if (typeof search.node === 'string') {
    result.node = search.node;
  }
  if (typeof search.tab === 'string' && (TABS as readonly string[]).includes(search.tab)) {
    result.tab = search.tab as ProjectTab;
  }
  return result;
}

export const Route = createFileRoute('/p/$projectId')({
  validateSearch,
  beforeLoad: requireAuth,
  loader: async ({ context, params }) => {
    try {
      const [project] = await Promise.all([
        context.queryClient.ensureQueryData(projects.detail(params.projectId)),
        context.queryClient.ensureQueryData(outline.flat(params.projectId)),
      ]);
      return { project };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        throw notFound();
      }
      throw error;
    }
  },
  pendingComponent: ProjectPendingSkeleton,
  notFoundComponent: () => <NotFoundView message="This project doesn't exist or was removed." />,
  component: ProjectLayout,
});

function ProjectLayout() {
  const { projectId } = Route.useParams();
  // The loader ensures this is already in the cache; re-subscribing here (rather than
  // reading `Route.useLoaderData()` alone) picks up settings/duplicate/delete mutations
  // without needing a full route reload.
  const { project } = Route.useLoaderData();
  const { data: liveProject } = useQuery(projects.detail(projectId));

  const current = liveProject ?? project;
  // Mounted once here (rather than in AppHeader/CopilotPanel individually) so the SSE
  // subscription and outline/header wiring stay alive across the whole project layout,
  // not just while a particular pane happens to be mounted.
  const { activeRun } = useActiveRun(projectId);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <AppHeader project={current} {...(activeRun ? { activeRun } : {})} />
      <Outlet />
      <ProjectSettingsDialog project={current} />
      <SourcesDialog projectId={projectId} />
      <StartRunDialog project={current} />
      <ExportDialog project={current} />
      <RunsPanel projectId={projectId} />
    </div>
  );
}

function ProjectPendingSkeleton() {
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <div className="flex h-16 shrink-0 items-center gap-3 border-b px-5">
        <Skeleton className="size-8 rounded-lg" />
        <Skeleton className="h-4 w-48" />
      </div>
      <div className="flex flex-1 overflow-hidden">
        <div className="hidden w-72 shrink-0 border-r p-3 lg:block lg:w-80">
          <Skeleton className="h-full w-full" />
        </div>
        <div className="flex-1 p-3">
          <Skeleton className="h-full w-full" />
        </div>
      </div>
    </div>
  );
}
