import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { History } from 'lucide-react';

import { runs as runQueries } from '@/api/queries/runs';
import type { Run } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import {
  formatCost,
  formatDuration,
  formatTokens,
  RUN_KIND_LABELS,
  RUN_STATUS_CLASSES,
  RUN_STATUS_LABELS,
} from '@/features/runs/lib/run-format';
import { useUiStore } from '@/stores/ui-store';

interface RunsPanelProps {
  projectId: string;
}

/** Mounted in the project layout; the header's Run history action opens it. */
export function RunsPanel({ projectId }: RunsPanelProps) {
  const activeModal = useUiStore((state) => state.activeModal);
  const closeModal = useUiStore((state) => state.closeModal);
  const open = activeModal === 'run-history';

  const { data, isPending } = useQuery({
    ...runQueries.list(projectId, { limit: 50 }),
    enabled: open,
  });
  const items = data?.items ?? [];

  let body: React.ReactNode;
  if (isPending) {
    body = (
      <div className="space-y-2">
        {['a', 'b', 'c'].map((key) => (
          <Skeleton key={key} className="h-10 w-full" />
        ))}
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <EmptyState
        icon={History}
        title="No runs yet"
        description="Start a run from the header to see its history here."
      />
    );
  } else {
    body = (
      <table className="w-full table-fixed text-left">
        <colgroup>
          <col className="w-32" />
          <col className="w-24" />
          <col className="w-32" />
          <col className="w-28" />
          <col className="w-20" />
          <col className="w-24" />
          <col className="w-24" />
        </colgroup>
        <thead className="text-[11px] font-semibold text-muted-foreground">
          <tr className="border-b">
            <th className="py-1.5 pl-1 font-semibold">Kind</th>
            <th className="py-1.5 font-semibold">Status</th>
            <th className="py-1.5 font-semibold">Started</th>
            <th className="py-1.5 font-semibold">Started by</th>
            <th className="py-1.5 font-semibold">Duration</th>
            <th className="py-1.5 font-semibold">Tokens</th>
            <th className="py-1.5 pr-1 font-semibold">Cost</th>
          </tr>
        </thead>
        <tbody>
          {items.map((run) => (
            <RunRow key={run.id} projectId={projectId} run={run} onNavigate={closeModal} />
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeModal()}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="size-4" />
            Run history
            <Badge variant="secondary">{items.length}</Badge>
          </DialogTitle>
          <DialogDescription>
            Every run started for this project, most recent first.
          </DialogDescription>
        </DialogHeader>

        <div className="custom-scrollbar flex-1 overflow-y-auto">{body}</div>
      </DialogContent>
    </Dialog>
  );
}

function RunRow({
  projectId,
  run,
  onNavigate,
}: {
  projectId: string;
  run: Run;
  onNavigate: () => void;
}) {
  const duration = formatDuration(run.startedAt, run.finishedAt);
  return (
    <tr className="border-b last:border-0 hover:bg-muted/40">
      <td className="py-1.5 pl-1">
        <Link
          to="/p/$projectId/runs/$runId"
          params={{ projectId, runId: run.id }}
          onClick={onNavigate}
          className="font-medium text-foreground hover:underline"
        >
          {RUN_KIND_LABELS[run.kind]}
        </Link>
      </td>
      <td className="py-1.5">
        <span
          className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium ${RUN_STATUS_CLASSES[run.status]}`}
        >
          {RUN_STATUS_LABELS[run.status]}
        </span>
      </td>
      <td className="py-1.5 text-xs text-muted-foreground">
        {run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}
      </td>
      <td className="truncate py-1.5 text-xs text-muted-foreground">
        {run.startedByName ?? '—'}
      </td>
      <td className="py-1.5 text-xs text-muted-foreground">{duration ?? '—'}</td>
      <td className="py-1.5 text-xs text-muted-foreground">
        {formatTokens(run.totalTokens) ?? '—'}
      </td>
      <td className="py-1.5 pr-1 text-xs text-muted-foreground">
        {formatCost(run.totalCostUsd) ?? '—'}
      </td>
    </tr>
  );
}
