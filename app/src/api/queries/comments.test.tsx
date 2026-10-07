import { useQuery } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { MOCK_USER } from '@/mocks/fixtures';
import { renderWithQueryClient, waitFor } from '@/test/query-test-utils';
import { makeAnchor } from '@/features/editor/lib/anchors';

import {
  comments,
  useCreateCommentMutation,
  useDeleteCommentMutation,
  useResolveCommentMutation,
  useUpdateCommentMutation,
} from './comments';
import { outline } from './outline';

const PROJECT_ID = 'book-consensus-quantum-2026';
const NODE_ID = 'sec-1-1';

function setup() {
  return renderWithQueryClient(() => ({
    threads: useQuery(comments.forNode(PROJECT_ID, NODE_ID)),
    flat: useQuery(outline.flat(PROJECT_ID)),
    create: useCreateCommentMutation(PROJECT_ID, NODE_ID),
    update: useUpdateCommentMutation(PROJECT_ID, NODE_ID),
    remove: useDeleteCommentMutation(PROJECT_ID, NODE_ID),
    resolve: useResolveCommentMutation(PROJECT_ID, NODE_ID),
  }));
}

const openCount = (flat: { items: { id: string; openCommentCount?: number }[] } | undefined) =>
  flat?.items.find((n) => n.id === NODE_ID)?.openCommentCount;

describe('comment queries', () => {
  it('creates an anchored comment, a reply, resolves and reopens, keeping the outline badge in step', async () => {
    const { result } = setup();
    await waitFor(() =>
      expect(result.current.threads.isSuccess && result.current.flat.isSuccess).toBe(true),
    );
    expect(result.current.threads.data?.items).toEqual([]);
    expect(openCount(result.current.flat.data)).toBe(0);

    const node = await (await fetch(`/api/v1/projects/${PROJECT_ID}/outline/${NODE_ID}`)).json();
    const text: string = node.contentMarkdown;
    const anchor = makeAnchor(text, 0, Math.min(12, text.length));

    result.current.create.mutate({ bodyMarkdown: 'Is this right?', anchor });
    await waitFor(() => expect(result.current.threads.data?.items).toHaveLength(1));
    // Optimistic row first, then the server's.
    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));
    await waitFor(() => expect(openCount(result.current.flat.data)).toBe(1));
    const root = result.current.threads.data!.items[0]!;
    expect(root.authorId).toBe(MOCK_USER.id);
    expect(root.anchor?.start).toBe(0);

    result.current.create.mutate({ bodyMarkdown: 'A reply', parentId: root.id });
    await waitFor(() => expect(result.current.threads.data?.items).toHaveLength(2));
    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));

    result.current.resolve.mutate({ commentId: root.id, resolved: true });
    await waitFor(() => expect(openCount(result.current.flat.data)).toBe(0));
    await waitFor(() =>
      expect(result.current.threads.data?.items.every((c) => c.status === 'resolved')).toBe(true),
    );

    result.current.resolve.mutate({ commentId: root.id, resolved: false });
    await waitFor(() => expect(openCount(result.current.flat.data)).toBe(1));

    result.current.update.mutate({ commentId: root.id, bodyMarkdown: 'Edited' });
    await waitFor(() =>
      expect(
        result.current.threads.data?.items.find((c) => c.id === root.id)?.editedAt,
      ).toBeTruthy(),
    );

    result.current.remove.mutate(root.id);
    await waitFor(() => expect(result.current.threads.data?.items).toHaveLength(0));
    await waitFor(() => expect(openCount(result.current.flat.data)).toBe(0));
  });

  it('rolls an optimistic comment back when the request fails', async () => {
    const { server } = await import('@/mocks/server');
    const { http, HttpResponse } = await import('msw');
    server.use(
      http.post('*/api/v1/projects/:projectId/outline/:nodeId/comments', () =>
        HttpResponse.json({ title: 'boom', status: 500 }, { status: 500 }),
      ),
    );
    const { result } = setup();
    await waitFor(() =>
      expect(result.current.threads.isSuccess && result.current.flat.isSuccess).toBe(true),
    );
    result.current.create.mutate({ bodyMarkdown: 'Will fail' });
    await waitFor(() => expect(result.current.create.isError).toBe(true));
    await waitFor(() => expect(result.current.threads.data?.items).toHaveLength(0));
    expect(openCount(result.current.flat.data)).toBe(0);
  });
});
