import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createQueryClient } from '@/app/query-client';
import { routeTree } from '@/routeTree.gen';

function renderApp(initialPath = '/') {
  const queryClient = createQueryClient();
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('root route', () => {
  it('renders the placeholder home page', async () => {
    renderApp('/');

    expect(await screen.findByText(/TODO: projects list/i)).toBeInTheDocument();
  });

  it('renders the placeholder project page for a dynamic route', async () => {
    renderApp('/p/demo-project');

    expect(await screen.findByText(/demo-project/i)).toBeInTheDocument();
  });
});
