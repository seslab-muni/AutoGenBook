import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { delay, http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import type { OutlineNode, Source } from '@/api/types';
import { server } from '@/mocks/server';

import { useEffectiveSources } from './use-effective-sources';

const PROJECT_ID = 'p1';

function node(overrides: Partial<OutlineNode> & { id: string }): OutlineNode {
  return {
    parentId: null,
    sectionNumber: '1',
    title: 'T',
    sourceScope: 'inherit',
    sourceIds: [],
    ...overrides,
  } as OutlineNode;
}

function source(id: string, status: Source['status'] = 'ready'): Source {
  return { id, name: `${id}.pdf`, status, type: 'pdf' } as Source;
}

function serveSources(all: Source[], opts: { slow?: boolean } = {}) {
  server.use(
    http.get('*/api/v1/projects/:projectId/sources', async ({ request }) => {
      const url = new URL(request.url);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (opts.slow) await delay(40);
      return HttpResponse.json({
        items: all.slice(offset, offset + limit),
        total: all.length,
        limit,
        offset,
      });
    }),
  );
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const FLAT = [
  node({ id: 'ch', sourceScope: 'selected', sourceIds: ['s1', 's3'] }),
  node({ id: 'leaf', parentId: 'ch' }),
  node({ id: 'own', parentId: 'ch', sourceScope: 'selected', sourceIds: ['s2'] }),
  node({ id: 'other' }),
];

describe('useEffectiveSources', () => {
  it('filters to the own selection, and to the nearest scoped ancestor when inheriting', async () => {
    serveSources([source('s1'), source('s2'), source('s3')]);
    const own = renderHook(() => useEffectiveSources(PROJECT_ID, 'own', FLAT), { wrapper });
    await waitFor(() => expect(own.result.current.loading).toBe(false));
    expect(own.result.current.sources.map((s) => s.id)).toEqual(['s2']);
    expect(own.result.current.scope.own).toBe(true);

    const inherited = renderHook(() => useEffectiveSources(PROJECT_ID, 'leaf', FLAT), { wrapper });
    await waitFor(() => expect(inherited.result.current.loading).toBe(false));
    expect(inherited.result.current.sources.map((s) => s.id)).toEqual(['s1', 's3']);
    expect(inherited.result.current.scopeFrom?.id).toBe('ch');
  });

  it('uses every project source when the scope is all, and reports loading first', async () => {
    serveSources([source('s1'), source('s2')], { slow: true });
    const { result } = renderHook(() => useEffectiveSources(PROJECT_ID, 'other', FLAT), {
      wrapper,
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.sources).toEqual([]);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sources).toHaveLength(2);
  });

  it('pages through projects with more sources than the first page', async () => {
    const many = Array.from({ length: 260 }, (_, index) => source(`m${index}`));
    serveSources(many);
    const { result } = renderHook(() => useEffectiveSources(PROJECT_ID, 'other', FLAT), {
      wrapper,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sources).toHaveLength(260);
  });

  it('separates sources whose indexing failed', async () => {
    serveSources([source('s1'), source('s2', 'error')]);
    const { result } = renderHook(() => useEffectiveSources(PROJECT_ID, 'other', FLAT), {
      wrapper,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sources.map((s) => s.id)).toEqual(['s1']);
    expect(result.current.failedSources.map((s) => s.id)).toEqual(['s2']);
  });
});
