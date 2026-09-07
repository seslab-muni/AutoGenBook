import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fileContentUrl } from '@/features/exports/lib/file-url';

/**
 * Fetches a run artifact's raw text content directly from `GET /files/{fileId}/content` (not
 * `openapi-fetch` — that endpoint's response is an opaque byte stream, not a typed JSON schema)
 * for inline previews: the Markdown card's excerpt, the log viewer, the audit report's JSON tree,
 * and the LLM usage summary. `maxBytes`, when given, truncates the response client-side (there's
 * no Range support to rely on in the mock or a guarantee of it from the real API) — good enough
 * for "first N KB of a Markdown file"; omit it to read a file in full (JSON/JSONL artifacts are
 * parsed as a whole, so truncating them would break parsing).
 */
export function useFileText(
  fileId: string | undefined,
  options: { maxBytes?: number; enabled?: boolean } = {},
): UseQueryResult<string> {
  const { maxBytes, enabled = true } = options;
  return useQuery({
    queryKey: ['exports', 'fileText', fileId, maxBytes],
    queryFn: async () => {
      const response = await fetch(fileContentUrl(fileId as string));
      if (!response.ok) {
        throw new Error(`Failed to fetch file ${fileId as string}: ${response.status}`);
      }
      const text = await response.text();
      return maxBytes !== undefined ? text.slice(0, maxBytes) : text;
    },
    enabled: enabled && fileId !== undefined,
    staleTime: Infinity,
  });
}
