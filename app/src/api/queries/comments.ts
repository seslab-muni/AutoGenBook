import { queryOptions, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { apiClient, unwrap } from '@/api/client';
import type { AuthUser, Comment, CommentAnchorIn, OutlineNode, Page } from '@/api/types';

import { authKeys, projectKeys } from './keys';

type CommentPage = Page<Comment>;

export const comments = {
  /** Every live thread of one node (root plus replies, oldest first), whatever its status. */
  forNode: (projectId: string, nodeId: string) =>
    queryOptions({
      queryKey: projectKeys.nodeComments(projectId, nodeId),
      queryFn: () =>
        unwrap(
          apiClient.GET('/api/v1/projects/{project_id}/outline/{node_id}/comments', {
            params: { path: { project_id: projectId, node_id: nodeId } },
          }),
        ),
    }),
};

/** Statuses the API counts in `openCommentCount` for a root comment. */
function countsAsOpen(comment: Pick<Comment, 'kind' | 'status' | 'parentId'>): boolean {
  return (
    comment.kind === 'comment' &&
    comment.parentId === null &&
    (comment.status === 'open' || comment.status === 'orphaned')
  );
}

/** Adds `delta` to a node's `openCommentCount` in every cached outline view, so the row badge moves at once. */
function bumpOpenCount(
  queryClient: QueryClient,
  projectId: string,
  nodeId: string,
  delta: number,
): void {
  if (delta === 0) return;
  const bump = (node: OutlineNode): OutlineNode =>
    node.id === nodeId
      ? { ...node, openCommentCount: Math.max(0, (node.openCommentCount ?? 0) + delta) }
      : node;
  queryClient.setQueriesData<Page<OutlineNode>>(
    { queryKey: projectKeys.outlineList(projectId, 'flat') },
    (page) => (page ? { ...page, items: page.items.map(bump) } : page),
  );
  queryClient.setQueryData<OutlineNode>(projectKeys.outlineNode(projectId, nodeId), (node) =>
    node ? bump(node) : node,
  );
}

function invalidateAfterWrite(queryClient: QueryClient, projectId: string, nodeId: string) {
  void queryClient.invalidateQueries({ queryKey: projectKeys.nodeComments(projectId, nodeId) });
  // The row badges (`openCommentCount`) come from the outline lists.
  void queryClient.invalidateQueries({ queryKey: projectKeys.outlineList(projectId, 'flat') });
  void queryClient.invalidateQueries({ queryKey: projectKeys.outlineList(projectId, 'tree') });
}

function patchComments(
  queryClient: QueryClient,
  projectId: string,
  nodeId: string,
  update: (items: Comment[]) => Comment[],
): void {
  queryClient.setQueryData<CommentPage>(projectKeys.nodeComments(projectId, nodeId), (page) => {
    if (!page) return page;
    const items = update(page.items);
    return { ...page, items, limit: items.length, total: items.filter((c) => !c.parentId).length };
  });
}

async function snapshot(queryClient: QueryClient, projectId: string, nodeId: string) {
  const key = projectKeys.nodeComments(projectId, nodeId);
  await queryClient.cancelQueries({ queryKey: key });
  return queryClient.getQueryData<CommentPage>(key);
}

export interface CreateCommentVariables {
  bodyMarkdown: string;
  anchor?: CommentAnchorIn | null;
  /** Replies target the thread root (the API makes every reply's parent the root). */
  parentId?: string | null;
}

/**
 * Creates a comment or reply. Optimistic: the card (or message) appears at once as a row with an
 * `optimistic-` id, and a new open root bumps the outline row's badge; both roll back on error.
 * Always refetches the node's threads and the outline afterwards for the server's view.
 */
export function useCreateCommentMutation(
  projectId: string,
  nodeId: string,
  { optimistic = true }: { optimistic?: boolean } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCommentVariables) =>
      unwrap(
        apiClient.POST('/api/v1/projects/{project_id}/outline/{node_id}/comments', {
          params: { path: { project_id: projectId, node_id: nodeId } },
          body: {
            bodyMarkdown: body.bodyMarkdown,
            ...(body.anchor ? { anchor: body.anchor } : {}),
            ...(body.parentId ? { parentId: body.parentId } : {}),
          },
        }),
      ),
    onMutate: async (body) => {
      // A composer that stays open until the server answers has no use for a pretend row.
      if (!optimistic) return { previous: undefined, bumped: 0 };
      const previous = await snapshot(queryClient, projectId, nodeId);
      const me = queryClient.getQueryData<AuthUser>(authKeys.me());
      const now = new Date().toISOString();
      const id = `optimistic-${crypto.randomUUID()}`;
      let bumped = 0;
      patchComments(queryClient, projectId, nodeId, (items) => {
        const root = body.parentId ? items.find((c) => c.id === body.parentId) : undefined;
        const optimistic: Comment = {
          id,
          projectId,
          nodeId,
          kind: 'comment',
          authorId: me?.id ?? null,
          authorName: me?.displayName ?? null,
          anchor: root ? root.anchor : (body.anchor ?? null),
          status: root ? root.status : 'open',
          threadId: root ? root.threadId : id,
          parentId: root ? root.id : null,
          bodyMarkdown: body.bodyMarkdown,
          payload: {},
          createdAt: now,
          updatedAt: now,
          editedAt: null,
        };
        if (!root) {
          bumped = 1;
          return [...items, optimistic];
        }
        // A reply reopens a resolved thread, and sits at the end of its thread.
        const reopened = root.status === 'resolved' ? 'open' : root.status;
        if (root.status === 'resolved' && root.kind === 'comment') bumped = 1;
        const threadId = root.threadId;
        const next = items.map((c) => (c.threadId === threadId ? { ...c, status: reopened } : c));
        let lastOfThread = -1;
        next.forEach((c, i) => {
          if (c.threadId === threadId) lastOfThread = i;
        });
        next.splice(lastOfThread + 1, 0, { ...optimistic, status: reopened });
        return next;
      });
      bumpOpenCount(queryClient, projectId, nodeId, bumped);
      return { previous, bumped };
    },
    onError: (_error, _body, context) => {
      if (!context || !optimistic) return;
      queryClient.setQueryData(projectKeys.nodeComments(projectId, nodeId), context.previous);
      bumpOpenCount(queryClient, projectId, nodeId, -context.bumped);
    },
    onSettled: () => invalidateAfterWrite(queryClient, projectId, nodeId),
  });
}

/** Edits a message's body (author only). Optimistic by default; marks it edited. */
export function useUpdateCommentMutation(
  projectId: string,
  nodeId: string,
  { optimistic = true }: { optimistic?: boolean } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, bodyMarkdown }: { commentId: string; bodyMarkdown: string }) =>
      unwrap(
        apiClient.PATCH('/api/v1/comments/{comment_id}', {
          params: { path: { comment_id: commentId } },
          body: { bodyMarkdown },
        }),
      ),
    onMutate: async ({ commentId, bodyMarkdown }) => {
      if (!optimistic) return { previous: undefined };
      const previous = await snapshot(queryClient, projectId, nodeId);
      const now = new Date().toISOString();
      patchComments(queryClient, projectId, nodeId, (items) =>
        items.map((c) =>
          c.id === commentId ? { ...c, bodyMarkdown, editedAt: now, updatedAt: now } : c,
        ),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context && optimistic)
        queryClient.setQueryData(projectKeys.nodeComments(projectId, nodeId), context.previous);
    },
    onSettled: () => invalidateAfterWrite(queryClient, projectId, nodeId),
  });
}

/** Deletes a message; deleting a thread root removes the whole thread. Optimistic. */
export function useDeleteCommentMutation(projectId: string, nodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) =>
      unwrap(
        apiClient.DELETE('/api/v1/comments/{comment_id}', {
          params: { path: { comment_id: commentId } },
        }),
      ),
    onMutate: async (commentId) => {
      const previous = await snapshot(queryClient, projectId, nodeId);
      const target = previous?.items.find((c) => c.id === commentId);
      const bumped = target && countsAsOpen(target) ? -1 : 0;
      patchComments(queryClient, projectId, nodeId, (items) =>
        items.filter((c) => c.id !== commentId && c.parentId !== commentId),
      );
      bumpOpenCount(queryClient, projectId, nodeId, bumped);
      return { previous, bumped };
    },
    onError: (_error, _id, context) => {
      if (!context) return;
      queryClient.setQueryData(projectKeys.nodeComments(projectId, nodeId), context.previous);
      bumpOpenCount(queryClient, projectId, nodeId, -context.bumped);
    },
    onSettled: () => invalidateAfterWrite(queryClient, projectId, nodeId),
  });
}

/** Resolves (or, with `resolved: false`, reopens) a thread. Optimistic on every row of the thread. */
export function useResolveCommentMutation(projectId: string, nodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, resolved }: { commentId: string; resolved: boolean }) =>
      unwrap(
        apiClient.POST('/api/v1/comments/{comment_id}/resolve', {
          params: { path: { comment_id: commentId } },
          body: { resolved },
        }),
      ),
    onMutate: async ({ commentId, resolved }) => {
      const previous = await snapshot(queryClient, projectId, nodeId);
      const root = previous?.items.find((c) => c.id === commentId);
      let bumped = 0;
      if (root && root.kind === 'comment') {
        if (resolved && root.status !== 'resolved') bumped = -1;
        if (!resolved && root.status === 'resolved') bumped = 1;
      }
      patchComments(queryClient, projectId, nodeId, (items) =>
        items.map((c) => {
          if (c.threadId !== (root?.threadId ?? commentId)) return c;
          const reopened =
            c.anchor && c.anchor.start == null && c.anchor.end == null ? 'orphaned' : 'open';
          return { ...c, status: resolved ? 'resolved' : reopened };
        }),
      );
      bumpOpenCount(queryClient, projectId, nodeId, bumped);
      return { previous, bumped };
    },
    onError: (_error, _vars, context) => {
      if (!context) return;
      queryClient.setQueryData(projectKeys.nodeComments(projectId, nodeId), context.previous);
      bumpOpenCount(queryClient, projectId, nodeId, -context.bumped);
    },
    onSettled: () => invalidateAfterWrite(queryClient, projectId, nodeId),
  });
}
