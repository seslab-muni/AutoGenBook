import { useQuery } from '@tanstack/react-query';
import { delay, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { problemResponse } from '@/mocks/problem';
import { server } from '@/mocks/server';
import { renderWithQueryClient, waitFor } from '@/test/query-test-utils';

import {
  outline,
  useCreateOutlineNodeMutation,
  useDeleteOutlineNodeMutation,
  useUpdateOutlineNodeMutation,
} from './outline';

const PROJECT_ID = 'book-consensus-quantum-2026';

describe('outline queries', () => {
  it('flat and tree views agree on the total node count', async () => {
    const { result } = renderWithQueryClient(() => ({
      flat: useQuery(outline.flat(PROJECT_ID)),
      tree: useQuery(outline.tree(PROJECT_ID)),
    }));

    await waitFor(() =>
      expect(result.current.flat.isSuccess && result.current.tree.isSuccess).toBe(true),
    );
    expect(result.current.flat.data?.total).toBe(result.current.tree.data?.total);
    expect(result.current.tree.data?.items[0]?.children.length).toBeGreaterThan(0);
    expect(result.current.flat.data?.items.every((node) => !('children' in node))).toBe(true);
  });

  it('creating a node invalidates both outline views, which refetch to include it', async () => {
    const { result } = renderWithQueryClient(() => ({
      flat: useQuery(outline.flat(PROJECT_ID)),
      tree: useQuery(outline.tree(PROJECT_ID)),
      create: useCreateOutlineNodeMutation(PROJECT_ID),
    }));
    await waitFor(() =>
      expect(result.current.flat.isSuccess && result.current.tree.isSuccess).toBe(true),
    );
    const initialTotal = result.current.flat.data?.total;

    result.current.create.mutate({ parentId: null, title: 'New Chapter' });
    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));

    await waitFor(() => expect(result.current.flat.data?.total).toBe((initialTotal ?? 0) + 1));
    expect(result.current.tree.data?.items.some((node) => node.title === 'New Chapter')).toBe(true);
  });

  it('updating a node’s content recomputes actualWords server-side', async () => {
    const { result } = renderWithQueryClient(() =>
      useUpdateOutlineNodeMutation(PROJECT_ID, 'sec-3-1'),
    );

    result.current.mutate({ contentMarkdown: 'one two three four five' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.actualWords).toBe(5);
  });

  it('creating a node inserts it into the flat cache immediately, then rolls back on error', async () => {
    server.use(
      http.post('*/api/v1/projects/:projectId/outline', async () => {
        await delay(150);
        return problemResponse(500, 'Simulated failure', '/api/v1/projects/x/outline');
      }),
    );
    const { result } = renderWithQueryClient(() => ({
      flat: useQuery(outline.flat(PROJECT_ID)),
      create: useCreateOutlineNodeMutation(PROJECT_ID),
    }));
    await waitFor(() => expect(result.current.flat.isSuccess).toBe(true));
    const initialTotal = result.current.flat.data?.total;

    result.current.create.mutate({ parentId: null, title: 'Optimistic Chapter' });

    await waitFor(() =>
      expect(
        result.current.flat.data?.items.some((node) => node.title === 'Optimistic Chapter'),
      ).toBe(true),
    );

    await waitFor(() => expect(result.current.create.isError).toBe(true));
    expect(
      result.current.flat.data?.items.some((node) => node.title === 'Optimistic Chapter'),
    ).toBe(false);
    expect(result.current.flat.data?.total).toBe(initialTotal);
  });

  it('deleting a node with descendants removes the whole subtree immediately, then rolls back on error', async () => {
    server.use(
      http.delete('*/api/v1/projects/:projectId/outline/:nodeId', async () => {
        await delay(150);
        return problemResponse(500, 'Simulated failure', '/api/v1/projects/x/outline/ch-1');
      }),
    );
    const { result } = renderWithQueryClient(() => ({
      flat: useQuery(outline.flat(PROJECT_ID)),
      remove: useDeleteOutlineNodeMutation(PROJECT_ID),
    }));
    await waitFor(() => expect(result.current.flat.isSuccess).toBe(true));
    const initialTotal = result.current.flat.data?.total;
    expect(result.current.flat.data?.items.some((node) => node.id === 'sec-1-1')).toBe(true);

    result.current.remove.mutate('ch-1');

    await waitFor(() =>
      expect(result.current.flat.data?.items.some((node) => node.id === 'ch-1')).toBe(false),
    );
    expect(result.current.flat.data?.items.some((node) => node.id === 'sec-1-1')).toBe(false);
    expect(result.current.flat.data?.items.some((node) => node.id === 'sec-1-2')).toBe(false);

    await waitFor(() => expect(result.current.remove.isError).toBe(true));
    expect(result.current.flat.data?.items.some((node) => node.id === 'ch-1')).toBe(true);
    expect(result.current.flat.data?.items.some((node) => node.id === 'sec-1-1')).toBe(true);
    expect(result.current.flat.data?.total).toBe(initialTotal);
  });
});
