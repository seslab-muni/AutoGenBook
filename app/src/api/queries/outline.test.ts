import { useQuery } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { renderWithQueryClient, waitFor } from '@/test/query-test-utils';

import { outline, useCreateOutlineNodeMutation, useUpdateOutlineNodeMutation } from './outline';

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
});
