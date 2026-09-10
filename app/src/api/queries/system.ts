import { queryOptions, useQuery } from '@tanstack/react-query';

import { apiClient, unwrap } from '@/api/client';

import { systemKeys } from './keys';

export const system = {
  /**
   * The models the configured LLM endpoint offers (`GET /system/models`), for the project
   * settings/start-run model pickers. The API caches this server-side for ~5 minutes
   * (`CachingModelCatalog`); `staleTime` here just avoids a redundant client-side refetch every
   * time a picker remounts within that same window - `ModelSelect` degrades to plain free text
   * on its own when `items` comes back empty, so a query error still doesn't need a retry/error
   * UI of its own.
   */
  models: () =>
    queryOptions({
      queryKey: systemKeys.models(),
      queryFn: () => unwrap(apiClient.GET('/api/v1/system/models')),
      staleTime: 60_000,
    }),
};

/** Convenience wrapper over `system.models()` — `ModelSelect` is the one place that needs it. */
export function useModels() {
  return useQuery(system.models());
}
