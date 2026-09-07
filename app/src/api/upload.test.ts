import { describe, expect, it, vi } from 'vitest';

import { FakeXhr } from '@/test/fake-xhr';

import { ApiError } from './client';
import { uploadFile } from './upload';

function makeFile(name = 'notes.md', content = 'hello world'): File {
  return new File([content], name, { type: 'text/markdown' });
}

describe('uploadFile', () => {
  it('resolves with the created File DTO on success', async () => {
    let fake!: FakeXhr;
    const promise = uploadFile(makeFile(), {
      createXhr: () => (fake = new FakeXhr()) as unknown as XMLHttpRequest,
    });
    fake.respond(201, { id: 'f1', filename: 'notes.md', kind: 'upload' });

    await expect(promise).resolves.toMatchObject({ id: 'f1', filename: 'notes.md' });
  });

  it('reports upload progress', async () => {
    const onProgress = vi.fn();
    let fake!: FakeXhr;
    const promise = uploadFile(makeFile(), {
      onProgress,
      createXhr: () => (fake = new FakeXhr()) as unknown as XMLHttpRequest,
    });
    fake.progress(50, 100);
    fake.progress(100, 100);
    fake.respond(201, { id: 'f1', filename: 'notes.md', kind: 'upload' });
    await promise;

    expect(onProgress).toHaveBeenNthCalledWith(1, 0.5);
    expect(onProgress).toHaveBeenNthCalledWith(2, 1);
  });

  it('rejects with a 413 ApiError when the server reports the file is too large', async () => {
    let fake!: FakeXhr;
    const promise = uploadFile(makeFile(), {
      createXhr: () => (fake = new FakeXhr()) as unknown as XMLHttpRequest,
    });
    fake.respond(413, {
      type: 'about:blank',
      title: 'Payload Too Large',
      status: 413,
      instance: '/api/v1/files',
    });

    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(413);
    expect((error as ApiError).problem?.title).toBe('Payload Too Large');
  });

  it('rejects with an ApiError on a network error', async () => {
    let fake!: FakeXhr;
    const promise = uploadFile(makeFile(), {
      createXhr: () => (fake = new FakeXhr()) as unknown as XMLHttpRequest,
    });
    fake.networkError();

    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
  });

  it('rejects when the request is aborted', async () => {
    const controller = new AbortController();
    let fake!: FakeXhr;
    const promise = uploadFile(makeFile(), {
      signal: controller.signal,
      createXhr: () => (fake = new FakeXhr()) as unknown as XMLHttpRequest,
    });
    controller.abort();

    await expect(promise).rejects.toThrow(/aborted/i);
    expect(fake.aborted).toBe(true);
  });
});
