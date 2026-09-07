import { describe, expect, it } from 'vitest';

import { apiClient, ApiError, unwrap } from './client';

describe('unwrap', () => {
  it('returns data on success', async () => {
    const project = await unwrap(
      apiClient.GET('/api/v1/projects/{projectId}', {
        params: { path: { projectId: 'book-consensus-quantum-2026' } },
      }),
    );
    expect(project.id).toBe('book-consensus-quantum-2026');
  });

  it('throws an ApiError with the parsed Problem on a 404', async () => {
    const error = await unwrap(
      apiClient.GET('/api/v1/projects/{projectId}', {
        params: { path: { projectId: 'does-not-exist' } },
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(404);
    expect(apiError.problem?.status).toBe(404);
    expect(apiError.problem?.type).toBe('about:blank');
  });

  it('throws an ApiError with the parsed Problem on a 422', async () => {
    const error = await unwrap(
      apiClient.PATCH('/api/v1/projects/{projectId}', {
        params: { path: { projectId: 'book-consensus-quantum-2026' } },
        body: { sources: [] } as never,
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
  });

  it('wraps a network failure (fetch rejection) as an ApiError with status 0', async () => {
    const brokenClient = apiClient;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new TypeError('network down'));

    const error = await unwrap(
      brokenClient.GET('/api/v1/projects/{projectId}', { params: { path: { projectId: 'x' } } }),
    ).catch((caught: unknown) => caught);

    globalThis.fetch = originalFetch;

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).problem).toBeUndefined();
  });
});
