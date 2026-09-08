import { useQuery } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { renderWithQueryClient, waitFor } from '@/test/query-test-utils';

import { projectKeys } from './keys';
import { projects, useCreateProjectMutation, useDeleteProjectMutation } from './projects';

describe('projects queries', () => {
  it('lists seeded project summaries', async () => {
    const { result } = renderWithQueryClient(() => useQuery(projects.list()));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items.map((p) => p.id)).toContain('book-consensus-quantum-2026');
    expect(result.current.data?.total).toBe(3);
  });

  it('fetches a project detail with its embedded sources and outline tree', async () => {
    const { result } = renderWithQueryClient(() =>
      useQuery(projects.detail('book-consensus-quantum-2026')),
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.title).toBe('Distributed Consensus & Quantum Fault Tolerance');
    expect(result.current.data?.sources?.length).toBeGreaterThan(0);
    expect(result.current.data?.outline?.[0]?.children?.length).toBeGreaterThan(0);
  });

  it('creating a project invalidates the list query, which refetches to include it', async () => {
    const { result } = renderWithQueryClient(() => ({
      list: useQuery(projects.list()),
      create: useCreateProjectMutation(),
    }));
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    expect(result.current.list.data?.total).toBe(3);

    result.current.create.mutate({
      title: 'New Book',
      subtitle: 'Sub',
      authors: ['Author'],
      topic: 'Topic',
    });
    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));

    await waitFor(() => expect(result.current.list.data?.total).toBe(4));
    expect(result.current.list.data?.items.some((p) => p.title === 'New Book')).toBe(true);
  });

  it('deleting a project removes its detail cache entry', async () => {
    const { result, queryClient } = renderWithQueryClient(() =>
      useDeleteProjectMutation('book-reinforcement-learning'),
    );
    queryClient.setQueryData(projectKeys.detail('book-reinforcement-learning'), {
      id: 'book-reinforcement-learning',
    });

    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(
      queryClient.getQueryData(projectKeys.detail('book-reinforcement-learning')),
    ).toBeUndefined();
  });
});
