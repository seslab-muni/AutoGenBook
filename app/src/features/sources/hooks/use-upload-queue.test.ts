import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FakeXhr } from '@/test/fake-xhr';

import { useUploadQueue } from './use-upload-queue';

function makeFile(name = 'notes.md', content = 'hello world'): File {
  return new File([content], name, { type: 'text/markdown' });
}

describe('useUploadQueue', () => {
  it('reports progress and calls onUploaded on success', async () => {
    const onUploaded = vi.fn();
    let fake!: FakeXhr;
    const { result } = renderHook(() =>
      useUploadQueue({
        onUploaded,
        createXhr: () => (fake = new FakeXhr()) as unknown as XMLHttpRequest,
      }),
    );

    act(() => result.current.enqueue([makeFile()]));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]?.status).toBe('uploading');

    act(() => fake.progress(50, 100));
    await waitFor(() => expect(result.current.items[0]?.progress).toBe(0.5));

    act(() => fake.respond(201, { id: 'f1', filename: 'notes.md', kbEligible: true }));
    await waitFor(() => expect(result.current.items[0]?.status).toBe('done'));

    expect(onUploaded).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f1', kbEligible: true }),
    );
  });

  it('marks the item canceled when aborted', async () => {
    let fake!: FakeXhr;
    const { result } = renderHook(() =>
      useUploadQueue({ createXhr: () => (fake = new FakeXhr()) as unknown as XMLHttpRequest }),
    );

    act(() => result.current.enqueue([makeFile()]));
    const id = result.current.items[0]!.id;
    act(() => result.current.cancel(id));

    await waitFor(() => expect(result.current.items[0]?.status).toBe('canceled'));
    expect(fake.aborted).toBe(true);
  });

  it('surfaces a 413 as a size-limit error message', async () => {
    let fake!: FakeXhr;
    const { result } = renderHook(() =>
      useUploadQueue({ createXhr: () => (fake = new FakeXhr()) as unknown as XMLHttpRequest }),
    );

    act(() => result.current.enqueue([makeFile()]));
    act(() =>
      fake.respond(413, {
        type: 'about:blank',
        title: 'Payload Too Large',
        status: 413,
        instance: '/api/v1/files',
      }),
    );

    await waitFor(() => expect(result.current.items[0]?.status).toBe('error'));
    expect(result.current.items[0]?.error).toMatch(/exceeds the server upload size limit/i);
  });

  it('predicts ineligibility from the extension before the server responds', () => {
    const { result } = renderHook(() =>
      useUploadQueue({ createXhr: () => new FakeXhr() as unknown as XMLHttpRequest }),
    );

    act(() => result.current.enqueue([makeFile('bibliography.bib')]));
    expect(result.current.items[0]?.eligible).toBe(false);
  });

  it('removes an item on dismiss', async () => {
    let fake!: FakeXhr;
    const { result } = renderHook(() =>
      useUploadQueue({ createXhr: () => (fake = new FakeXhr()) as unknown as XMLHttpRequest }),
    );

    act(() => result.current.enqueue([makeFile()]));
    act(() => fake.respond(201, { id: 'f1', filename: 'notes.md', kbEligible: true }));
    await waitFor(() => expect(result.current.items[0]?.status).toBe('done'));

    act(() => result.current.dismiss(result.current.items[0]!.id));
    expect(result.current.items).toHaveLength(0);
  });
});
