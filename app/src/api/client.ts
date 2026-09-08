import createClient, { type Middleware } from 'openapi-fetch';

import { authKeys } from '@/api/queries/keys';
import { queryClient } from '@/app/query-client';
import { router } from '@/app/router';
import { getAuthHeaders } from '@/auth/session';

import type { paths } from './schema.gen';
import type { Problem } from './types';

/**
 * Paths in `schema.gen.ts` already carry the full `/api/v1/...` prefix (see
 * `docs/openapi.yaml`'s `servers: [{ url: / }]`), so the base URL is just a
 * host prefix in front of that — the current origin by default, which
 * resolves through the Vite dev proxy or nginx's `/api/` block exactly like
 * a plain relative fetch would in a browser. Spelled out explicitly (rather
 * than left relative) because Node's `fetch` — unlike a browser's — has no
 * document to resolve a relative URL against, which matters for tests.
 */
export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? window.location.origin;

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem | undefined;
  readonly url: string;

  constructor(params: {
    status: number;
    problem: Problem | undefined;
    url: string;
    cause?: unknown;
  }) {
    super(
      params.problem?.title ??
        `Request to ${params.url || '<unknown>'} failed with status ${params.status}`,
      {
        cause: params.cause,
      },
    );
    this.name = 'ApiError';
    this.status = params.status;
    this.problem = params.problem;
    this.url = params.url;
  }
}

function isProblem(value: unknown): value is Problem {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    'title' in value &&
    'type' in value &&
    'instance' in value
  );
}

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    return Array.from(crypto.getRandomValues(new Uint32Array(4)), (word) =>
      word.toString(36),
    ).join('');
  }
  return Math.random().toString(36).slice(2);
}

const requestMiddleware: Middleware = {
  onRequest({ request }) {
    const authHeaders = getAuthHeaders();
    for (const [name, value] of Object.entries(authHeaders)) {
      request.headers.set(name, value);
    }
    request.headers.set('X-Request-Id', createRequestId());
    return request;
  },
};

/**
 * A 401 on any request other than `/auth/login` itself means the session died (expired, or
 * signed out in another tab) — not a normal "wrong password" (that 401 is login's own, handled
 * inline by the login form). Clears the cached `auth.me()` and sends the user back to `/login`
 * with the page they were on so a fresh sign-in returns them there.
 */
const responseMiddleware: Middleware = {
  onResponse({ response, schemaPath }) {
    if (response.status === 401 && schemaPath !== '/api/v1/auth/login') {
      queryClient.removeQueries({ queryKey: authKeys.all });
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      void router.navigate({ to: '/login', search: { redirect: current } });
    }
    return response;
  },
};

export const apiClient = createClient<paths>({
  baseUrl: apiBaseUrl,
  // openapi-fetch resolves its default `fetch` once, at client-construction time — this wraps
  // it so every call reads `globalThis.fetch` fresh, which MSW (patched in via `server.listen()`
  // after this module has already been imported) needs to be able to intercept requests.
  fetch: (input) => globalThis.fetch(input),
});
apiClient.use(requestMiddleware);
apiClient.use(responseMiddleware);

interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/**
 * Awaits an openapi-fetch call and either returns its `data` or throws an
 * `ApiError` — the single place non-2xx responses and network failures
 * become rejections that TanStack Query (and everything else) can rely on.
 */
export async function unwrap<T>(promise: Promise<FetchResult<T>>): Promise<T> {
  let result: FetchResult<T>;
  try {
    result = await promise;
  } catch (cause) {
    throw new ApiError({ status: 0, problem: undefined, url: '', cause });
  }
  if (result.error !== undefined) {
    throw new ApiError({
      status: result.response.status,
      problem: isProblem(result.error) ? result.error : undefined,
      url: result.response.url,
    });
  }
  return result.data as T;
}
