import type { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';

import { queryClient } from '@/app/query-client';
import { routeTree } from '@/routeTree.gen';

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}

/**
 * The app's single router instance, built off the singleton `queryClient`. `AppProviders` feeds
 * this to `RouterProvider`; `src/auth/session.ts` (`signOut`) and `src/api/client.ts` (the 401
 * response middleware) import it directly to navigate from outside the React tree, the same way
 * they import the singleton `queryClient`. Tests use their own router (`renderRouterApp`, on a
 * memory history) instead of this one.
 */
export const router = createAppRouter(queryClient);
