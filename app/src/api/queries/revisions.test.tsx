import { act } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import type { Comment, OutlineNode } from '@/api/types';
import { server } from '@/mocks/server';
import { renderWithQueryClient } from '@/test/query-test-utils';

import { projectKeys } from './keys';
import { useAcceptSuggestionMutation, useRestoreContentMutation } from './revisions';

const P = 'book-reinforcement-learning';
const N = 'rl-sec-1-1';
const key = projectKeys.outlineNode(P, N);
const node = (text: string, hash: string) =>
  ({ id: N, contentMarkdown: text, contentHash: hash }) as OutlineNode;

describe('a section fetch that started before the copilot wrote the text', () => {
  it('cannot land after an accept and put the old text and hash back', async () => {
    const { result, queryClient } = renderWithQueryClient(() => useAcceptSuggestionMutation(P, N));
    queryClient.setQueryData(key, node('before', 'h-before'));
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => (finish = resolve));
    // A refetch of the section is in flight (a window focus, a poll) and will answer with the OLD text.
    const fetching = queryClient
      .fetchQuery({
        queryKey: key,
        queryFn: () => slow.then(() => node('before', 'h-before')),
        staleTime: 0,
      })
      .catch(() => undefined);
    server.use(
      http.post('*/api/v1/suggestions/:id/accept', () =>
        HttpResponse.json({
          suggestion: { id: 's', kind: 'suggestion', status: 'accepted' } as Comment,
          node: node('after', 'h-after'),
        }),
      ),
    );
    await act(async () => {
      await result.current.mutateAsync({ suggestionId: 's' });
    });
    finish();
    await fetching;
    expect(queryClient.getQueryData<OutlineNode>(key)).toMatchObject({
      contentMarkdown: 'after',
      contentHash: 'h-after',
    });
  });

  it('nor after an undo', async () => {
    const { result, queryClient } = renderWithQueryClient(() => useRestoreContentMutation(P, N));
    queryClient.setQueryData(key, node('after', 'h-after'));
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => (finish = resolve));
    const fetching = queryClient
      .fetchQuery({
        queryKey: key,
        queryFn: () => slow.then(() => node('after', 'h-after')),
        staleTime: 0,
      })
      .catch(() => undefined);
    server.use(
      http.patch('*/api/v1/projects/:projectId/outline/:nodeId', () =>
        HttpResponse.json(node('before', 'h-before')),
      ),
    );
    await act(async () => {
      await result.current.mutateAsync({
        contentMarkdown: 'before',
        expectedContentHash: 'h-after',
      });
    });
    finish();
    await fetching;
    expect(queryClient.getQueryData<OutlineNode>(key)).toMatchObject({
      contentMarkdown: 'before',
      contentHash: 'h-before',
    });
  });
});
