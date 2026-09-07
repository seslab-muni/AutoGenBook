import { useQuery } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { db } from '@/mocks/db';
import { renderWithQueryClient, waitFor } from '@/test/query-test-utils';

import { fileKeys } from './keys';
import { files, useDeleteFileMutation } from './files';

describe('files queries', () => {
  it('lists seeded files', async () => {
    const { result } = renderWithQueryClient(() => useQuery(files.list()));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items.length).toBeGreaterThan(0);
  });

  it('fetches a single file’s metadata', async () => {
    const { result } = renderWithQueryClient(() => useQuery(files.detail('file-lamport-1982')));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.filename).toBe('Lamport_1982_ByzantineGenerals.pdf');
  });

  it('deleting a referenced file is rejected with a 409', async () => {
    const { result } = renderWithQueryClient(() => useDeleteFileMutation());

    result.current.mutate('file-lamport-1982');
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('deleting an unreferenced file removes its cache entry', async () => {
    const unreferencedId = db.nextId();
    db.files.set(unreferencedId, {
      id: unreferencedId,
      filename: 'scratch.txt',
      contentType: 'text/plain',
      sizeBytes: 12,
      sha256: 'sha',
      kind: 'upload',
      kbEligible: true,
      createdAt: db.now(),
    });

    const { result, queryClient } = renderWithQueryClient(() => useDeleteFileMutation());
    queryClient.setQueryData(fileKeys.detail(unreferencedId), { id: unreferencedId });

    result.current.mutate(unreferencedId);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryData(fileKeys.detail(unreferencedId))).toBeUndefined();
  });
});
