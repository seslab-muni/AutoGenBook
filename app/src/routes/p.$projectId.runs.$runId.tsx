import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { AlertTriangle, ArrowLeft, PlayCircle, RotateCw, Square } from 'lucide-react';
import { toast } from 'sonner';

import { ApiError } from '@/api/client';
import { runs as runQueries, useCancelRunMutation, useRetryRunMutation } from '@/api/queries/runs';
import type { RunEvent } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ArtifactsList } from '@/features/exports/components/artifacts-list';
import { RunCostSummary } from '@/features/exports/components/run-cost-summary';
import { RunEventLog } from '@/features/runs/components/run-event-log';
import {
  RUN_KIND_LABELS,
  RUN_STATUS_CLASSES,
  RUN_STATUS_LABELS,
} from '@/features/runs/lib/run-format';
import { useActiveRun } from '@/features/runs/hooks/use-active-run';
import { useRunStream } from '@/features/runs/hooks/use-run-stream';
import { useDocumentTitle } from '@/lib/use-document-title';

export const Route = createFileRoute('/p/$projectId/runs/$runId')({
  component: RunPage,
});

const RUNNING_STATUSES = new Set(['queued', 'running']);

function mergeEvents(pages: RunEvent[], live: RunEvent[]): RunEvent[] {
  const byId = new Map<number, RunEvent>();
  for (const event of pages) byId.set(event.seq, event);
  for (const event of live) byId.set(event.seq, event);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

function RunPage() {
  const { projectId, runId } = Route.useParams();
  const navigate = useNavigate();
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const [confirmResumeOpen, setConfirmResumeOpen] = useState(false);

  const { data: run, isPending } = useQuery(runQueries.detail(runId));
  useDocumentTitle(run ? `${RUN_KIND_LABELS[run.kind]} · Run` : `Run ${runId}`);

  // Fetches the run's full history once (a generous limit rather than "load more" paging via
  // afterSeq — the mock's simulated runs top out at a few dozen events; see `RunEventLog`'s
  // note on the same simplification for the live view) and merges it with whatever
  // `useRunStream` has appended live, so a run opened after it already finished still shows
  // its complete log.
  const { data: historyPage } = useQuery(runQueries.events(runId, { limit: 500 }));
  const { events: liveEvents } = useRunStream(runId, projectId);
  const events = useMemo(
    () => mergeEvents(historyPage?.items ?? [], liveEvents),
    [historyPage, liveEvents],
  );

  const { data: artifacts } = useQuery(runQueries.artifacts(runId));

  const cancelMutation = useCancelRunMutation();
  const retryMutation = useRetryRunMutation(projectId);
  const { activeRun } = useActiveRun(projectId);

  function handleCancel() {
    if (!run) return;
    cancelMutation.mutate(run.id, {
      onSuccess: () => {
        toast.success('Run cancelled');
        setConfirmCancelOpen(false);
      },
      onError: (error) => {
        const problem = error instanceof ApiError ? error.problem : undefined;
        toast.error(problem?.detail ?? problem?.title ?? 'Could not cancel the run');
        setConfirmCancelOpen(false);
      },
    });
  }

  function handleResume() {
    if (!run) return;
    retryMutation.mutate(run.id, {
      onSuccess: (newRun) => {
        toast.success('Run resumed');
        setConfirmResumeOpen(false);
        void navigate({
          to: '/p/$projectId/runs/$runId',
          params: { projectId, runId: newRun.id },
        });
      },
      onError: (error) => {
        const problem = error instanceof ApiError ? error.problem : undefined;
        toast.error(problem?.detail ?? problem?.title ?? 'Could not resume the run');
        setConfirmResumeOpen(false);
      },
    });
  }

  if (isPending) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!run) {
    return <EmptyState title="Run not found" description={`No run with id ${runId}.`} />;
  }

  const isRunning = RUNNING_STATUSES.has(run.status);
  // Captured as a local so the closure below narrows to `string` (a `run.targetNodeId` property
  // access wouldn't narrow across the closure boundary under `exactOptionalPropertyTypes`).
  const regenerateAgainNodeId = run.kind === 'regenerate_section' ? run.targetNodeId : null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b p-4">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back to project"
            onClick={() => void navigate({ to: '/p/$projectId', params: { projectId } })}
          >
            <ArrowLeft />
          </Button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-bold text-foreground">
                {RUN_KIND_LABELS[run.kind]}
              </h1>
              <span
                className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium ${RUN_STATUS_CLASSES[run.status]}`}
              >
                {RUN_STATUS_LABELS[run.status]}
              </span>
              {run.resumable ? <Badge variant="outline">Resumable</Badge> : null}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {run.targetNodeId ? `Target node ${run.targetNodeId} · ` : ''}
              Queued {new Date(run.queuedAt).toLocaleString()} · Started by{' '}
              {run.startedByName ?? '—'}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {regenerateAgainNodeId ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                void navigate({
                  to: '/p/$projectId',
                  params: { projectId },
                  search: { node: regenerateAgainNodeId },
                })
              }
            >
              <RotateCw />
              Regenerate again
            </Button>
          ) : null}
          {run.retryable ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={Boolean(activeRun)}
              title={activeRun ? 'Another run is already active for this project' : undefined}
              onClick={() => setConfirmResumeOpen(true)}
            >
              <PlayCircle />
              Resume
            </Button>
          ) : null}
          {isRunning ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => setConfirmCancelOpen(true)}
            >
              <Square />
              Cancel
            </Button>
          ) : null}
        </div>
      </div>

      {run.error ? (
        <div className="m-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{run.error}</span>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 overflow-hidden p-4 md:grid-cols-[2fr_1fr]">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
          <div className="border-b bg-muted/40 px-3 py-2 text-xs font-semibold text-foreground">
            Event log
          </div>
          <RunEventLog events={events} className="flex-1 p-2" />
        </div>

        <div className="custom-scrollbar space-y-4 overflow-y-auto">
          <div className="rounded-lg border p-3">
            <RunCostSummary run={run} />
            <p className="mt-2 text-xs text-muted-foreground">
              Exit code: <span className="font-mono">{run.exitCode ?? '—'}</span>
            </p>
          </div>

          <div className="rounded-lg border">
            <div className="border-b bg-muted/40 px-3 py-2 text-xs font-semibold text-foreground">
              Artifacts
            </div>
            <div className="p-3">
              <ArtifactsList
                artifacts={artifacts?.items ?? []}
                emptyMessage="Artifacts appear here once the run produces output."
              />
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmCancelOpen}
        onOpenChange={setConfirmCancelOpen}
        title="Cancel this run?"
        description="The CLI process is stopped; any sections it already drafted stay as they are."
        confirmLabel="Cancel run"
        cancelLabel="Keep running"
        onConfirm={handleCancel}
      />

      <ConfirmDialog
        open={confirmResumeOpen}
        onOpenChange={setConfirmResumeOpen}
        title="Resume this run?"
        description="Starts a new run that continues from the sections this run already generated; already-finished sections are not regenerated."
        confirmLabel="Resume run"
        cancelLabel="Cancel"
        onConfirm={handleResume}
      />
    </div>
  );
}
