import { HttpResponse } from 'msw';

import type { Problem } from '@/api/types';

/** Builds a `application/problem+json` response, matching `api/core/errors.py`. */
export function problemResponse(status: number, title: string, instance: string, detail?: string) {
  const body: Problem = { type: 'about:blank', title, status, detail: detail ?? null, instance };
  return HttpResponse.json(body, {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

export function notFound(resource: string, instance: string) {
  return problemResponse(404, `${resource} not found`, instance);
}
