import { useQuery } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { db } from '@/mocks/db';
import { renderWithQueryClient, waitFor } from '@/test/query-test-utils';

import { projects } from './projects';
import { sources, useAddSourceMutation, useRemoveSourceMutation } from './sources';

const PROJECT_ID = 'book-consensus-quantum-2026';

describe('sources queries', () => {
  it('lists a project’s attached sources', async () => {
    const { result } = renderWithQueryClient(() => useQuery(sources.list(PROJECT_ID)));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      result.current.data?.items.some((s) => s.name === 'Lamport_1982_ByzantineGenerals.pdf'),
    ).toBe(true);
  });

  it('adding a source invalidates the project’s source list and detail', async () => {
    const file = db.nextId();
    db.files.set(file, {
      id: file,
      filename: 'extra-notes.md',
      contentType: 'text/markdown',
      sizeBytes: 1024,
      sha256: 'sha',
      kind: 'upload',
      kbEligible: true,
      createdAt: db.now(),
    });

    const { result } = renderWithQueryClient(() => ({
      list: useQuery(sources.list(PROJECT_ID)),
      detail: useQuery(projects.detail(PROJECT_ID)),
      add: useAddSourceMutation(PROJECT_ID),
    }));
    await waitFor(() =>
      expect(result.current.list.isSuccess && result.current.detail.isSuccess).toBe(true),
    );

    result.current.add.mutate({ fileId: file });
    await waitFor(() => expect(result.current.add.isSuccess).toBe(true));

    await waitFor(() =>
      expect(result.current.list.data?.items.some((s) => s.name === 'extra-notes.md')).toBe(true),
    );
    await waitFor(() =>
      expect(result.current.detail.data?.sources.some((s) => s.name === 'extra-notes.md')).toBe(
        true,
      ),
    );
  });

  it('removing a source invalidates the source list', async () => {
    const sourceId = [...db.sources.values()].find((s) => s.projectId === PROJECT_ID)!.id;
    const { result } = renderWithQueryClient(() => ({
      list: useQuery(sources.list(PROJECT_ID)),
      remove: useRemoveSourceMutation(PROJECT_ID),
    }));
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    expect(result.current.list.data?.items.some((s) => s.id === sourceId)).toBe(true);

    result.current.remove.mutate(sourceId);
    await waitFor(() => expect(result.current.remove.isSuccess).toBe(true));

    await waitFor(() =>
      expect(result.current.list.data?.items.some((s) => s.id === sourceId)).toBe(false),
    );
  });
});
