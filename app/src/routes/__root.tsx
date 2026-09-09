import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';

import { ErrorView } from '@/components/layout/error-view';
import { NotFoundView } from '@/components/layout/not-found-view';
import { Toaster } from '@/components/ui/sonner';
import { NewProjectDialog } from '@/features/projects/components/new-project-dialog';
import { reportError } from '@/lib/report-error';

export interface RootRouteContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RootRouteContext>()({
  component: RootLayout,
  notFoundComponent: () => <NotFoundView />,
  errorComponent: ({ error }) => {
    reportError(error, { source: 'router.errorComponent' });
    return <ErrorView error={error} />;
  },
});

function RootLayout() {
  return (
    <div className="h-screen bg-background font-sans text-foreground">
      <Outlet />
      <Toaster />
      <NewProjectDialog />
    </div>
  );
}
