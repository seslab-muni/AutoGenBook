import { queryOptions, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { apiClient, unwrap } from '@/api/client';
import type {
  Comment,
  OutlineNode,
  Page,
  RevisionCreate,
  SuggestionAccepted,
  StartedRevision,
} from '@/api/types';

import { bumpNodeCount, invalidateAfterWrite, patchComments } from './comments';
import { projectKeys } from './keys';

/** The copilot (issue #182 phase 4): revisions, suggestions and what accepting one does to the caches. */

export const suggestions = {
  /** One suggestion with its full payload (the polling fallback of the event stream reads this). */
  detail: (suggestionId: string) =>
    queryOptions({
      queryKey: ['suggestions', suggestionId] as const,
      queryFn: () =>
        unwrap(
          apiClient.GET('/api/v1/comments/{comment_id}', {
            params: { path: { comment_id: suggestionId } },
          }),
        ),
    }),
};

/** Puts `row` into a node's threads: a new thread at the end, a row of an existing thread after its last row. */
function insertRow(items: Comment[], row: Comment): Comment[] {
  if (items.some((item) => item.id === row.id)) return replaceRow(items, row);
  if (row.threadId === row.id) return [...items, row];
  let last = -1;
  items.forEach((item, i) => {
    if (item.threadId === row.threadId) last = i;
  });
  const next = [...items];
  next.splice(last === -1 ? next.length : last + 1, 0, row);
  return next;
}

/** `row` instead of the row with its id, keeping the thread's anchor and status on its replies. */
function replaceRow(items: Comment[], row: Comment): Comment[] {
  return items.map((item) => (item.id === row.id ? row : item));
}

/** Writes a suggestion the server sent (a progress terminal event, a poll, a mutation response) into the node's threads. */
export function putSuggestion(
  queryClient: QueryClient,
  projectId: string,
  nodeId: string,
  suggestion: Comment,
): void {
  patchComments(queryClient, projectId, nodeId, (items) => insertRow(items, suggestion));
}

function isActive(status: Comment['status'] | undefined): boolean {
  return status === 'running' || status === 'pending';
}

/** The row badge follows the suggestion leaving the running/pending states. */
export function settleSuggestion(
  queryClient: QueryClient,
  projectId: string,
  nodeId: string,
  before: Comment['status'] | undefined,
  after: Comment['status'],
): void {
  if (isActive(before) && !isActive(after)) {
    bumpNodeCount(queryClient, projectId, nodeId, 'pendingSuggestionCount', -1);
  }
  void queryClient.invalidateQueries({ queryKey: projectKeys.outlineList(projectId, 'flat') });
  void queryClient.invalidateQueries({ queryKey: projectKeys.outlineList(projectId, 'tree') });
  void queryClient.invalidateQueries({ queryKey: projectKeys.nodeComments(projectId, nodeId) });
}

function currentStatus(
  queryClient: QueryClient,
  projectId: string,
  nodeId: string,
  suggestionId: string,
): Comment['status'] | undefined {
  return queryClient
    .getQueryData<Page<Comment>>(projectKeys.nodeComments(projectId, nodeId))
    ?.items.find((item) => item.id === suggestionId)?.status;
}

/**
 * `POST .../revisions`. A revise answers with its new `running` suggestion, which goes into the
 * node's threads at once (its card appears and the row badge counts it); a rewrite answers with the
 * regenerate run it became, so the node's status and the run list are refetched instead.
 */
export function useStartRevisionMutation(projectId: string, nodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RevisionCreate): Promise<StartedRevision> =>
      unwrap(
        apiClient.POST('/api/v1/projects/{project_id}/outline/{node_id}/revisions', {
          params: { path: { project_id: projectId, node_id: nodeId } },
          body,
        }),
      ),
    onSuccess: (started) => {
      if (started.kind === 'suggestion') {
        putSuggestion(queryClient, projectId, nodeId, started.suggestion);
        bumpNodeCount(queryClient, projectId, nodeId, 'pendingSuggestionCount', 1);
      } else {
        void queryClient.invalidateQueries({ queryKey: projectKeys.runs(projectId) });
        void queryClient.invalidateQueries({ queryKey: projectKeys.outline(projectId) });
      }
    },
    onSettled: () => invalidateAfterWrite(queryClient, projectId, nodeId),
  });
}

export interface AcceptVariables {
  suggestionId: string;
  /** Apply just these hunks (section scope); a partial accept settles no thread or issue. */
  hunkIndexes?: number[];
  /** The `contentHash` of the section text the client shows, after flushing autosave. */
  expectedContentHash?: string | undefined;
}

/**
 * `POST /suggestions/{id}/accept`. On success the returned node (its text, its new `contentHash`)
 * replaces the section's cache entry and the list rows, the suggestion row becomes `accepted`, and
 * the node's threads are refetched (other cards were re-anchored, the addressed ones resolved).
 * On any failure the section is fetched again so the editor shows what the server holds.
 */
export function useAcceptSuggestionMutation(projectId: string, nodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      suggestionId,
      hunkIndexes,
      expectedContentHash,
    }: AcceptVariables): Promise<SuggestionAccepted> =>
      unwrap(
        apiClient.POST('/api/v1/suggestions/{suggestion_id}/accept', {
          params: { path: { suggestion_id: suggestionId } },
          body: {
            ...(hunkIndexes ? { hunkIndexes } : {}),
            ...(expectedContentHash ? { expectedContentHash } : {}),
          },
        }),
      ),
    onSuccess: ({ suggestion, node }, { suggestionId }) => {
      const before = currentStatus(queryClient, projectId, nodeId, suggestionId);
      queryClient.setQueryData<OutlineNode>(projectKeys.outlineNode(projectId, nodeId), node);
      const listRow = { ...node, contentHash: null };
      queryClient.setQueriesData<Page<OutlineNode>>(
        { queryKey: projectKeys.outlineList(projectId, 'flat') },
        (page) =>
          page
            ? { ...page, items: page.items.map((item) => (item.id === nodeId ? listRow : item)) }
            : page,
      );
      putSuggestion(queryClient, projectId, nodeId, suggestion);
      settleSuggestion(queryClient, projectId, nodeId, before, suggestion.status);
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.outlineNode(projectId, nodeId) });
      void queryClient.invalidateQueries({ queryKey: projectKeys.nodeComments(projectId, nodeId) });
    },
  });
}

/** `POST /suggestions/{id}/reject` and `.../cancel`: both answer with the updated suggestion. */
function useSuggestionTransition(projectId: string, nodeId: string, action: 'reject' | 'cancel') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (suggestionId: string): Promise<Comment> =>
      unwrap(
        action === 'reject'
          ? apiClient.POST('/api/v1/suggestions/{suggestion_id}/reject', {
              params: { path: { suggestion_id: suggestionId } },
            })
          : apiClient.POST('/api/v1/suggestions/{suggestion_id}/cancel', {
              params: { path: { suggestion_id: suggestionId } },
            }),
      ),
    onSuccess: (suggestion) => {
      const before = currentStatus(queryClient, projectId, nodeId, suggestion.id);
      putSuggestion(queryClient, projectId, nodeId, suggestion);
      settleSuggestion(queryClient, projectId, nodeId, before, suggestion.status);
    },
    onError: () => {
      // Someone else (or the job itself) got there first: show what the server says.
      void queryClient.invalidateQueries({ queryKey: projectKeys.nodeComments(projectId, nodeId) });
    },
  });
}

export function useRejectSuggestionMutation(projectId: string, nodeId: string) {
  return useSuggestionTransition(projectId, nodeId, 'reject');
}

export function useCancelSuggestionMutation(projectId: string, nodeId: string) {
  return useSuggestionTransition(projectId, nodeId, 'cancel');
}

/** `PATCH` back the text a suggestion replaced ("Undo" right after an accept), guarded by the hash the accept returned. */
export function useRestoreContentMutation(projectId: string, nodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      contentMarkdown,
      expectedContentHash,
    }: {
      contentMarkdown: string;
      expectedContentHash: string;
    }): Promise<OutlineNode> =>
      unwrap(
        apiClient.PATCH('/api/v1/projects/{project_id}/outline/{node_id}', {
          params: { path: { project_id: projectId, node_id: nodeId } },
          body: { contentMarkdown, expectedContentHash },
        }),
      ),
    onSuccess: (node) => {
      queryClient.setQueryData<OutlineNode>(projectKeys.outlineNode(projectId, nodeId), node);
      invalidateAfterWrite(queryClient, projectId, nodeId);
    },
  });
}
