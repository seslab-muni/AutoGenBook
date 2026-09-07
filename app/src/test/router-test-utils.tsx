import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, type RenderResult } from '@testing-library/react';

import { createQueryClient } from '@/app/query-client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { routeTree } from '@/routeTree.gen';

/** Renders the real route tree (MSW-backed) at `initialPath`, for router/loader integration tests. */
export function renderRouterApp(initialPath = '/'): RenderResult {
  const queryClient = createQueryClient();
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}
