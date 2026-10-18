import { useQuery } from '@tanstack/react-query';
import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { comments } from './comments';
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
    expect(result.current.tree.data?.items[0]?.children?.length).toBeGreaterThan(0);
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

  it('a late response to one PATCH does not overwrite fields another PATCH just saved', async () => {
    const { result } = renderWithQueryClient(() => ({
      node: useQuery(outline.node(PROJECT_ID, 'sec-1-1')),
      lock: useUpdateOutlineNodeMutation(PROJECT_ID, 'sec-1-1'),
      save: useUpdateOutlineNodeMutation(PROJECT_ID, 'sec-1-1'),
    }));
    await waitFor(() => expect(result.current.node.isSuccess).toBe(true));
    const stale = result.current.node.data!;

    // The lock toggle's response is computed from the pre-save content and lands last.
    server.use(
      http.patch('*/api/v1/projects/:projectId/outline/:nodeId', async ({ request }) => {
        const body = (await request.clone().json()) as { contentLocked?: boolean };
        if (body.contentLocked === undefined) return undefined;
        await delay(80);
        return HttpResponse.json({ ...stale, contentLocked: true });
      }),
    );

    result.current.lock.mutate({ contentLocked: true });
    result.current.save.mutate({ contentMarkdown: 'fresh text after the lock' });
    await waitFor(() => expect(result.current.save.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.lock.isSuccess).toBe(true));

    expect(result.current.node.data?.contentMarkdown).toBe('fresh text after the lock');
    expect(result.current.node.data?.contentLocked).toBe(true);
  });

  it.each([
    ['targetPages', { targetPages: 7 }, { wordBudget: 2450 }],
    [
      'parentId',
      { parentId: 'ch-2' },
      { parentId: 'ch-2', orderIndex: 3, sectionNumber: '2.4', level: 2 },
    ],
    ['sourceScope', { sourceScope: 'all' }, { sourceScope: 'all', sourceIds: [] }],
  ] as const)(
    'keeps what the server derives from a %s change in the node cache',
    async (_name, body, derived) => {
      const { result } = renderWithQueryClient(() => ({
        node: useQuery(outline.node(PROJECT_ID, 'sec-1-1')),
        update: useUpdateOutlineNodeMutation(PROJECT_ID, 'sec-1-1'),
      }));
      await waitFor(() => expect(result.current.node.isSuccess).toBe(true));
      const before = result.current.node.data!;
      server.use(
        http.patch('*/api/v1/projects/:projectId/outline/:nodeId', () =>
          HttpResponse.json({ ...before, ...body, ...derived }),
        ),
      );

      result.current.update.mutate({ ...body });
      await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
      expect(result.current.node.data).toMatchObject({ ...body, ...derived });
    },
  );

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

  it("a content save refetches the node's comments (the server re-anchors them), a title change does not", async () => {
    let commentFetches = 0;
    server.use(
      http.get('*/api/v1/projects/:projectId/outline/:nodeId/comments', () => {
        commentFetches += 1;
        return HttpResponse.json({ items: [], total: 0, limit: 0, offset: 0 });
      }),
    );
    const { result } = renderWithQueryClient(() => ({
      comments: useQuery(comments.forNode(PROJECT_ID, 'sec-1-1')),
      update: useUpdateOutlineNodeMutation(PROJECT_ID, 'sec-1-1'),
    }));
    await waitFor(() => expect(result.current.comments.isSuccess).toBe(true));
    expect(commentFetches).toBe(1);

    result.current.update.mutate({ title: 'Renamed' });
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(commentFetches).toBe(1);

    result.current.update.mutate({ contentMarkdown: 'New text.' });
    await waitFor(() => expect(commentFetches).toBe(2));
  });
});
