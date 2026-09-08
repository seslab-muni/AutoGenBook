/**
 * The shape one entry of `OutlineNode.ragCitations` is expected to have. The API types the
 * field itself only as `Record<string, unknown>[]` — freeform JSON persisted from LLM output,
 * with no backing Pydantic model — so this is narrowed here, at the one place the app reads it,
 * rather than trusted structurally throughout the editor UI.
 */
export interface RagCitation {
  id: string;
  sourceDoc: string;
  authorYear?: string | undefined;
  sectionSnippet?: string | undefined;
  relevanceScore: number;
  pageNumber?: number | null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function parseRagCitation(entry: Record<string, unknown>, index: number): RagCitation {
  return {
    id: asString(entry.id) ?? String(index),
    sourceDoc: asString(entry.sourceDoc) ?? 'Unknown source',
    authorYear: asString(entry.authorYear),
    sectionSnippet: asString(entry.sectionSnippet),
    relevanceScore: asNumber(entry.relevanceScore) ?? 0,
    pageNumber: asNumber(entry.pageNumber) ?? null,
  };
}

/** Narrows a node's raw `ragCitations` into the shape the editor UI expects, defaulting fields that are missing or the wrong type rather than throwing. */
export function parseRagCitations(
  entries: readonly Record<string, unknown>[] | undefined,
): RagCitation[] {
  return (entries ?? []).map(parseRagCitation);
}
