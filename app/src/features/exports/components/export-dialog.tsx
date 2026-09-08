import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Check, Copy, Download, FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { ApiError } from '@/api/client';
import { runs as runQueries, useExportRunMutation } from '@/api/queries/runs';
import type { Project, Run, RunArtifact } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/empty-state';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ArtifactsList } from '@/features/exports/components/artifacts-list';
import { RunCostSummary } from '@/features/exports/components/run-cost-summary';
import { findArtifact } from '@/features/exports/lib/artifacts';
import { fileContentUrl } from '@/features/exports/lib/file-url';
import { useFileText } from '@/features/exports/hooks/use-file-text';
import { LazyMarkdownView } from '@/features/editor/components/markdown-view-lazy';
import { useRunStream } from '@/features/runs/hooks/use-run-stream';
import { RUN_KIND_LABELS } from '@/features/runs/lib/run-format';
import { useUiStore } from '@/stores/ui-store';

/** First N KB of the Markdown artifact shown inline before the "download for the rest" hint. */
const MARKDOWN_PREVIEW_BYTES = 8 * 1024;

const BUILD_ARTIFACT_KIND: Record<'latex' | 'pdf', 'tex' | 'pdf'> = {
  latex: 'tex',
  pdf: 'pdf',
};

const BUILD_LABEL: Record<'latex' | 'pdf', string> = {
  latex: 'Build LaTeX',
  pdf: 'Build PDF',
};

interface ExportDialogProps {
  project: Project;
}

interface PendingBuild {
  format: 'latex' | 'pdf';
  runId: string;
}

/**
 * `activeModal === 'export'` dialog (issue #22): pick a succeeded base run, then download or
 * build each output format from it. Only one export/build can be in flight at a time (the API
 * allows exactly one active run per project), tracked here as `pendingBuild` rather than per-card
 * state so a 409 from a second click can never leave two cards spinning.
 */
export function ExportDialog({ project }: ExportDialogProps) {
  const activeModal = useUiStore((state) => state.activeModal);
  const closeModal = useUiStore((state) => state.closeModal);
  const openModal = useUiStore((state) => state.openModal);
  const open = activeModal === 'export';

  const { data: runsPage, isPending: runsPending } = useQuery({
    ...runQueries.list(project.id, { limit: 50 }),
    enabled: open,
  });
  const succeededRuns = useMemo(
    () => (runsPage?.items ?? []).filter((run) => run.status === 'succeeded'),
    [runsPage],
  );

  const [baseRunId, setBaseRunId] = useState<string | null>(null);
  const [pendingBuild, setPendingBuild] = useState<PendingBuild | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  // Reset per-open state (selected base run, in-flight build, error banner) each time the dialog
  // opens, the same "derive from a wasOpen ref" pattern `StartRunDialog` uses instead of an effect.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPendingBuild(null);
      setConflict(null);
    }
  }

  let effectiveBaseRunId: string | null;
  if (baseRunId && succeededRuns.some((run) => run.id === baseRunId)) {
    effectiveBaseRunId = baseRunId;
  } else if (project.lastRunId && succeededRuns.some((run) => run.id === project.lastRunId)) {
    effectiveBaseRunId = project.lastRunId;
  } else {
    effectiveBaseRunId = succeededRuns[0]?.id ?? null;
  }
  const baseRun = succeededRuns.find((run) => run.id === effectiveBaseRunId);

  const { data: baseArtifactsPage } = useQuery({
    ...runQueries.artifacts(effectiveBaseRunId ?? ''),
    enabled: open && effectiveBaseRunId !== null,
  });
  const baseArtifacts = baseArtifactsPage?.items ?? [];

  const exportMutation = useExportRunMutation(effectiveBaseRunId ?? '', project.id);

  // Live status of an in-flight build, and its own artifacts once it succeeds (the newly-built
  // tex/pdf shows up there, not in the base run's own artifact list — see `useExportRunMutation`'s
  // note on what it invalidates and `useRunStream`'s `invalidateForDone`, which invalidates the
  // *export* run's artifacts query as soon as its "done" event lands).
  useRunStream(pendingBuild?.runId, project.id);
  const { data: pendingRun } = useQuery({
    ...runQueries.detail(pendingBuild?.runId ?? ''),
    enabled: pendingBuild !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === undefined || status === 'queued' || status === 'running' ? 400 : false;
    },
  });
  const buildStillActive =
    pendingBuild !== null &&
    (pendingRun === undefined || pendingRun.status === 'queued' || pendingRun.status === 'running');
  const { data: pendingArtifactsPage } = useQuery({
    ...runQueries.artifacts(pendingBuild?.runId ?? ''),
    enabled: pendingBuild !== null,
    // Keeps polling the export run's own artifacts until it lands on a terminal status — the SSE
    // stream's own "done" handler (`useRunStream`'s `invalidateForDone`) would normally trigger
    // this refetch instantly, but that depends on a live connection this dialog doesn't assume.
    refetchInterval: buildStillActive ? 400 : false,
  });

  function handleBuild(format: 'latex' | 'pdf') {
    if (!effectiveBaseRunId) return;
    setConflict(null);
    exportMutation.mutate(
      { format },
      {
        onSuccess: (run: Run) => {
          setPendingBuild({ format, runId: run.id });
          toast.success(`${BUILD_LABEL[format]} started`);
        },
        onError: (error) => {
          if (error instanceof ApiError && error.status === 409) {
            setConflict(error.problem?.detail ?? error.problem?.title ?? 'A run is already active');
            return;
          }
          const problem = error instanceof ApiError ? error.problem : undefined;
          toast.error(
            problem?.detail ?? problem?.title ?? `Could not start ${BUILD_LABEL[format]}`,
          );
        },
      },
    );
  }

  function builtArtifact(format: 'latex' | 'pdf'): RunArtifact | undefined {
    const kind = BUILD_ARTIFACT_KIND[format];
    const fromBase = findArtifact(baseArtifacts, kind);
    if (fromBase) return fromBase;
    if (pendingBuild?.format === format) {
      return findArtifact(pendingArtifactsPage?.items, kind);
    }
    return undefined;
  }

  function buildStateFor(format: 'latex' | 'pdf'): { runId: string; run: Run | undefined } | null {
    if (pendingBuild?.format !== format) return null;
    return { runId: pendingBuild.runId, run: pendingRun };
  }

  const markdownArtifact = findArtifact(baseArtifacts, 'markdown');
  const bibArtifact = findArtifact(baseArtifacts, 'bib');

  let dialogBody: React.ReactNode;
  if (runsPending) {
    dialogBody = (
      <div className="space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  } else if (succeededRuns.length === 0 || !baseRun) {
    dialogBody = (
      <EmptyState
        icon={FileText}
        title="No succeeded run yet"
        description="Start a full run first — exports build from a run's finished output."
        action={
          <Button
            type="button"
            size="sm"
            onClick={() => {
              closeModal();
              openModal('start-run');
            }}
          >
            Start a run
          </Button>
        }
      />
    );
  } else {
    dialogBody = (
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground" htmlFor="export-base-run">
            Base run
          </label>
          <Select value={baseRun.id} onValueChange={(value) => setBaseRunId(value)}>
            <SelectTrigger id="export-base-run" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {succeededRuns.map((run) => (
                <SelectItem key={run.id} value={run.id}>
                  {RUN_KIND_LABELS[run.kind]} · {new Date(run.queuedAt).toLocaleString()}
                  {!run.resumable ? ' (not resumable)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <RunCostSummary run={baseRun} className="rounded-lg border bg-muted/30 p-2" />
          {!baseRun.resumable ? (
            <p className="flex items-center gap-1.5 text-[11px] text-warning">
              <AlertTriangle className="size-3" />
              This run's work directory is gone — building from it will fail; start a new run.
            </p>
          ) : null}
        </div>

        {conflict ? (
          <div className="flex items-start justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{conflict}</span>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                closeModal();
                openModal('start-run');
              }}
            >
              Start a full run
            </Button>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <MarkdownCard artifact={markdownArtifact} />
          <BibCard artifact={bibArtifact} />
          <BuildableFormatCard
            format="latex"
            artifact={builtArtifact('latex')}
            buildState={buildStateFor('latex')}
            disabled={!baseRun.resumable || exportMutation.isPending || pendingBuild !== null}
            onBuild={() => handleBuild('latex')}
          />
          <BuildableFormatCard
            format="pdf"
            artifact={builtArtifact('pdf')}
            buildState={buildStateFor('pdf')}
            disabled={!baseRun.resumable || exportMutation.isPending || pendingBuild !== null}
            onBuild={() => handleBuild('pdf')}
          />
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold text-foreground">All files</h3>
          <ArtifactsList artifacts={baseArtifacts} emptyMessage="This run has no artifacts yet." />
        </div>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeModal()}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Export</DialogTitle>
          <DialogDescription>
            Download this project's generated Markdown/BibTeX, or build LaTeX/PDF from a succeeded
            run.
          </DialogDescription>
        </DialogHeader>

        {dialogBody}
      </DialogContent>
    </Dialog>
  );
}

function FormatCardShell({
  title,
  description,
  testId,
  children,
}: {
  title: string;
  description?: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3" data-testid={testId}>
      <div>
        <p className="text-xs font-semibold text-foreground">{title}</p>
        {description ? <p className="text-[11px] text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </div>
  );
}

function MarkdownCard({ artifact }: { artifact: RunArtifact | undefined }) {
  const previewQuery = useFileText(artifact?.fileId, {
    maxBytes: MARKDOWN_PREVIEW_BYTES,
    enabled: artifact !== undefined,
  });

  if (!artifact) {
    return (
      <FormatCardShell title="Markdown" testId="export-card-markdown">
        <p className="text-[11px] text-muted-foreground">No Markdown artifact on this run.</p>
      </FormatCardShell>
    );
  }

  return (
    <FormatCardShell title="Markdown" description={artifact.filename} testId="export-card-markdown">
      <Button type="button" variant="outline" size="sm" asChild>
        <a href={fileContentUrl(artifact.fileId)} download={artifact.filename}>
          <Download />
          Download
        </a>
      </Button>
      <div className="max-h-40 overflow-auto rounded-md border bg-muted/30 p-2 text-[11px]">
        {previewQuery.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <LazyMarkdownView markdown={previewQuery.data ?? ''} />
        )}
      </div>
    </FormatCardShell>
  );
}

function BibCard({ artifact }: { artifact: RunArtifact | undefined }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    if (!artifact) return;
    fetch(fileContentUrl(artifact.fileId))
      .then((response) => response.text())
      .then((text) => navigator.clipboard.writeText(text))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => toast.error('Could not copy BibTeX to clipboard'));
  }

  if (!artifact) {
    return (
      <FormatCardShell title="BibTeX" testId="export-card-bib">
        <p className="text-[11px] text-muted-foreground">No BibTeX artifact on this run.</p>
      </FormatCardShell>
    );
  }

  return (
    <FormatCardShell title="BibTeX" description={artifact.filename} testId="export-card-bib">
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" asChild>
          <a href={fileContentUrl(artifact.fileId)} download={artifact.filename}>
            <Download />
            Download
          </a>
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
          {copied ? <Check className="text-success" /> : <Copy />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </FormatCardShell>
  );
}

const RUNNING_STATUSES = new Set<Run['status']>(['queued', 'running']);

interface BuildableFormatCardProps {
  format: 'latex' | 'pdf';
  artifact: RunArtifact | undefined;
  buildState: { runId: string; run: Run | undefined } | null;
  disabled: boolean;
  onBuild: () => void;
}

function BuildableFormatCard({
  format,
  artifact,
  buildState,
  disabled,
  onBuild,
}: BuildableFormatCardProps) {
  const title = format === 'latex' ? 'LaTeX' : 'PDF';
  const testId = `export-card-${BUILD_ARTIFACT_KIND[format]}`;

  if (artifact) {
    return (
      <FormatCardShell title={title} description={artifact.filename} testId={testId}>
        <Button type="button" variant="outline" size="sm" asChild>
          <a href={fileContentUrl(artifact.fileId)} download={artifact.filename}>
            <Download />
            Download
          </a>
        </Button>
      </FormatCardShell>
    );
  }

  if (buildState && (!buildState.run || RUNNING_STATUSES.has(buildState.run.status))) {
    return (
      <FormatCardShell title={title} testId={testId}>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Building…
        </div>
      </FormatCardShell>
    );
  }

  if (buildState?.run?.status === 'failed') {
    return (
      <FormatCardShell title={title} testId={testId}>
        <p className="text-[11px] text-destructive">{buildState.run.error ?? 'Build failed.'}</p>
        <Button type="button" variant="outline" size="sm" onClick={onBuild} disabled={disabled}>
          Retry
        </Button>
      </FormatCardShell>
    );
  }

  return (
    <FormatCardShell title={title} testId={testId}>
      <Button type="button" variant="outline" size="sm" onClick={onBuild} disabled={disabled}>
        {BUILD_LABEL[format]}
      </Button>
    </FormatCardShell>
  );
}
