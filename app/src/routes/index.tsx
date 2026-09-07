import { createFileRoute } from '@tanstack/react-router';

import { projects } from '@/api/queries/projects';
import { requireAuth } from '@/auth/require-auth';
import { Skeleton } from '@/components/ui/skeleton';
import { ProjectsHub } from '@/features/projects/components/projects-hub';
import { useDocumentTitle } from '@/lib/use-document-title';

export const Route = createFileRoute('/')({
  beforeLoad: requireAuth,
  loader: ({ context }) => context.queryClient.ensureQueryData(projects.list({ limit: 100 })),
  pendingComponent: HubPendingSkeleton,
  component: HomePage,
});

function HomePage() {
  useDocumentTitle();

  return <ProjectsHub />;
}

function HubPendingSkeleton() {
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <div className="flex h-16 shrink-0 items-center gap-3 border-b px-6">
        <Skeleton className="size-8 rounded-lg" />
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-4 p-8 sm:grid-cols-2 lg:grid-cols-3">
        {['a', 'b', 'c'].map((key) => (
          <Skeleton key={key} className="h-36 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}
