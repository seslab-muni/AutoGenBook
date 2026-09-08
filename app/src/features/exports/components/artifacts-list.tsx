import { useState } from 'react';
import { ChevronRight, Download } from 'lucide-react';

import type { RunArtifact } from '@/api/types';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { JsonTree } from '@/features/exports/components/json-tree';
import { useFileText } from '@/features/exports/hooks/use-file-text';
import {
  ARTIFACT_KIND_LABELS,
  formatBytes,
  groupArtifactsByKind,
} from '@/features/exports/lib/artifacts';
import { fileContentUrl } from '@/features/exports/lib/file-url';
import { formatCost, formatTokens } from '@/features/runs/lib/run-format';
import { cn } from '@/lib/utils';

interface ArtifactsListProps {
  artifacts: readonly RunArtifact[];
  emptyMessage?: string;
  className?: string;
}

/**
 * Every artifact a run produced, grouped by `kind` — shared between the export dialog's "All
 * files" section and the run detail route (issue #21). A plain download link for most kinds;
 * `audit_report`/`llm_usage`/`log` get a small inline preview beneath the row, expanded on demand
 * so opening the list never eagerly fetches every artifact's bytes.
 */
export function ArtifactsList({ artifacts, emptyMessage, className }: ArtifactsListProps) {
  if (artifacts.length === 0) {
    return (
      <EmptyState title="No artifacts yet" description={emptyMessage ?? 'Nothing produced yet.'} />
    );
  }

  const groups = groupArtifactsByKind(artifacts);

  return (
    <div className={cn('space-y-4', className)}>
      {groups.map((group) => (
        <div key={group.kind}>
          <h4 className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {ARTIFACT_KIND_LABELS[group.kind]}
          </h4>
          <ul className="divide-y rounded-lg border">
            {group.items.map((artifact) => (
              <ArtifactRow key={artifact.fileId} artifact={artifact} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ArtifactRow({ artifact }: { artifact: RunArtifact }) {
  return (
    <li className="p-2.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{artifact.filename}</p>
          <p className="text-muted-foreground">{formatBytes(artifact.sizeBytes)}</p>
        </div>
        <Button type="button" variant="outline" size="sm" asChild className="shrink-0">
          <a href={fileContentUrl(artifact.fileId)} download={artifact.filename}>
            <Download />
            Download
          </a>
        </Button>
      </div>
      {artifact.kind === 'audit_report' ? <AuditReportPreview artifact={artifact} /> : null}
      {artifact.kind === 'llm_usage' ? <LlmUsageSummary artifact={artifact} /> : null}
      {artifact.kind === 'log' ? <LogPreview artifact={artifact} /> : null}
    </li>
  );
}

/** Toggle + lazily-fetched content, shared by the audit report and log previews. */
function usePreviewToggle() {
  const [open, setOpen] = useState(false);
  return { open, toggle: () => setOpen((prev) => !prev) };
}

function AuditReportPreview({ artifact }: { artifact: RunArtifact }) {
  const { open, toggle } = usePreviewToggle();
  const textQuery = useFileText(artifact.fileId, { enabled: open });

  let parsed: unknown;
  let parseError = false;
  if (textQuery.data !== undefined) {
    try {
      parsed = JSON.parse(textQuery.data);
    } catch {
      parseError = true;
    }
  }

  let preview: React.ReactNode;
  if (textQuery.isPending) {
    preview = <p className="text-muted-foreground">Loading…</p>;
  } else if (parseError) {
    preview = <p className="text-destructive">Could not parse this report as JSON.</p>;
  } else {
    preview = <JsonTree value={parsed} />;
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        {open ? 'Hide findings' : 'Show findings'}
      </button>
      {open ? (
        <div className="mt-1.5 max-h-64 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px]">
          {preview}
        </div>
      ) : null}
    </div>
  );
}

interface LlmUsageLine {
  totalTokens?: number | null;
  totalCostUsd?: number | null;
  costUsd?: number | null;
}

function summarizeUsage(text: string): {
  calls: number;
  tokens: number | null;
  cost: number | null;
} {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  let tokens: number | null = null;
  let cost = 0;
  let hasCost = false;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as LlmUsageLine;
      if (typeof entry.totalTokens === 'number') tokens = entry.totalTokens;
      if (typeof entry.totalCostUsd === 'number') {
        cost = entry.totalCostUsd;
        hasCost = true;
      } else if (typeof entry.costUsd === 'number') {
        cost += entry.costUsd;
        hasCost = true;
      }
    } catch {
      // Skip a malformed line rather than failing the whole summary.
    }
  }
  return { calls: lines.length, tokens, cost: hasCost ? cost : null };
}

function LlmUsageSummary({ artifact }: { artifact: RunArtifact }) {
  const textQuery = useFileText(artifact.fileId);

  if (textQuery.isPending) {
    return <p className="mt-1 text-[11px] text-muted-foreground">Summarizing…</p>;
  }
  if (!textQuery.data) return null;

  const { calls, tokens, cost } = summarizeUsage(textQuery.data);
  return (
    <p className="mt-1 text-[11px] text-muted-foreground">
      {calls} call{calls === 1 ? '' : 's'}
      {tokens != null ? ` · ${formatTokens(tokens)}` : ''}
      {cost != null ? ` · ${formatCost(cost)}` : ''}
    </p>
  );
}

function LogPreview({ artifact }: { artifact: RunArtifact }) {
  const { open, toggle } = usePreviewToggle();
  const textQuery = useFileText(artifact.fileId, { enabled: open });

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        {open ? 'Hide log' : 'View log'}
      </button>
      {open ? (
        <pre
          role="log"
          className="mt-1.5 max-h-64 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px] whitespace-pre-wrap"
        >
          {textQuery.isPending ? 'Loading…' : textQuery.data}
        </pre>
      ) : null}
    </div>
  );
}
