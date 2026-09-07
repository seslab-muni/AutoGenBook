import type { ArtifactKind, RunArtifact } from '@/api/types';

export const ARTIFACT_KIND_LABELS: Record<ArtifactKind, string> = {
  markdown: 'Markdown',
  tex: 'LaTeX',
  pdf: 'PDF',
  structure_graph: 'Structure graph',
  book_structure: 'Book structure',
  section: 'Section',
  section_review: 'Section review',
  kb_sources: 'Knowledge base sources',
  run_meta: 'Run metadata',
  llm_usage: 'LLM usage',
  audit_report: 'Audit report',
  log: 'Log',
  bib: 'BibTeX',
  other: 'Other',
};

/** Stable display order for grouped artifact sections — primary outputs first, diagnostics last. */
export const ARTIFACT_KIND_ORDER: ArtifactKind[] = [
  'markdown',
  'pdf',
  'tex',
  'bib',
  'section',
  'section_review',
  'structure_graph',
  'book_structure',
  'kb_sources',
  'run_meta',
  'llm_usage',
  'audit_report',
  'log',
  'other',
];

export function findArtifact(
  artifacts: readonly RunArtifact[] | undefined,
  kind: ArtifactKind,
): RunArtifact | undefined {
  return artifacts?.find((artifact) => artifact.kind === kind);
}

/** Groups artifacts by `kind`, in `ARTIFACT_KIND_ORDER` — kinds with no artifacts are omitted. */
export function groupArtifactsByKind(
  artifacts: readonly RunArtifact[],
): { kind: ArtifactKind; items: RunArtifact[] }[] {
  const byKind = new Map<ArtifactKind, RunArtifact[]>();
  for (const artifact of artifacts) {
    const items = byKind.get(artifact.kind) ?? [];
    items.push(artifact);
    byKind.set(artifact.kind, items);
  }
  return ARTIFACT_KIND_ORDER.filter((kind) => byKind.has(kind)).map((kind) => ({
    kind,
    items: byKind.get(kind) ?? [],
  }));
}

/** `1.2 KB` / `3.4 MB` — base-1024, one decimal, matching how file managers usually show size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/** The `sections/<cliKey>.md` artifact the CLI writes for one leaf node, if this run produced it. */
export function findSectionArtifact(
  artifacts: readonly RunArtifact[] | undefined,
  cliKey: string | null | undefined,
): RunArtifact | undefined {
  if (!cliKey) return undefined;
  return artifacts?.find(
    (artifact) => artifact.kind === 'section' && artifact.relativePath === `sections/${cliKey}.md`,
  );
}
