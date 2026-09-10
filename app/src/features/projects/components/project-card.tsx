import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  Copy,
  Database,
  DollarSign,
  FileText,
  ListTree,
  MoreVertical,
  Trash2,
  UserRound,
} from 'lucide-react';
import { toast } from 'sonner';

import { useDeleteProjectMutation, useDuplicateProjectMutation } from '@/api/queries/projects';
import { runs as runQueries } from '@/api/queries/runs';
import type { ProjectSummary, Run } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  formatCost,
  formatRelativeTime,
  RUN_STATUS_DOT_CLASSES,
  RUN_STATUS_LABELS,
  RUN_STATUS_TEXT_CLASSES,
} from '@/features/runs/lib/run-format';
import { cn } from '@/lib/utils';

interface ProjectCardProps {
  project: ProjectSummary;
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/** One `pages / sources / nodes / cost` chip. They wrap as a group instead of sharing one
 * non-wrapping line with the owner name, which is what used to overflow narrow cards. */
function StatChip({
  icon: Icon,
  children,
  title,
}: {
  icon: typeof FileText;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <Badge
      variant="outline"
      className="gap-1 text-[11px] font-medium text-muted-foreground"
      {...(title ? { title } : {})}
    >
      <Icon className="text-muted-foreground" />
      {children}
    </Badge>
  );
}

function LastRunStatus({ run, hasRun }: { run: Run | undefined; hasRun: boolean }) {
  if (!hasRun) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
        <span className="size-1.5 rounded-full bg-muted-foreground/50" />
        No runs yet
      </span>
    );
  }
  if (!run) return null;
  const when = formatRelativeTime(run.finishedAt ?? run.startedAt ?? run.queuedAt);
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1.5 font-medium',
        RUN_STATUS_TEXT_CLASSES[run.status],
      )}
      title="Last run"
    >
      <span className={cn('size-1.5 rounded-full', RUN_STATUS_DOT_CLASSES[run.status])} />
      {RUN_STATUS_LABELS[run.status]}
      {when ? ` · ${when}` : null}
    </span>
  );
}

export function ProjectCard({ project }: ProjectCardProps) {
  const navigate = useNavigate();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const duplicateMutation = useDuplicateProjectMutation(project.id);
  const deleteMutation = useDeleteProjectMutation(project.id);
  // `ProjectSummary` (this card's prop) has no cost/status field of its own — a light query keyed
  // off `lastRunId` is the minimal way to surface them without the API adding one just for this card.
  const { data: lastRun } = useQuery({
    ...runQueries.detail(project.lastRunId ?? ''),
    enabled: project.lastRunId !== null,
  });
  const lastRunCost = lastRun ? formatCost(lastRun.totalCostUsd) : null;

  function open() {
    void navigate({ to: '/p/$projectId', params: { projectId: project.id } });
  }

  function handleDuplicate() {
    duplicateMutation.mutate(undefined, {
      onSuccess: (copy) => {
        toast.success(`Duplicated as "${copy.title}"`);
        void navigate({ to: '/p/$projectId', params: { projectId: copy.id } });
      },
    });
  }

  function handleDelete() {
    deleteMutation.mutate(undefined, {
      onSuccess: () => toast.success('Project deleted'),
    });
  }

  return (
    <>
      {/* Not `role="button"` on the `Card` itself: it used to wrap the "Project actions"
          dropdown's real `<button>`, an interactive control nested inside another interactive
          control — invalid (WCAG 4.1.2) and flagged by axe's `nested-interactive` rule (issue
          #23). Instead, an absolutely-positioned transparent button stretches under the whole
          card to carry the "open" click/keyboard interaction, and the content above it opts
          back into pointer events only where `DropdownMenu` needs its own clicks — the two
          controls end up as siblings in the DOM instead of one nested inside the other. */}
      <Card className="relative gap-3 p-4 transition-colors hover:border-primary/50 hover:shadow-md">
        <button
          type="button"
          aria-label={`Open ${project.title}`}
          onClick={open}
          className="absolute inset-0 z-0 cursor-pointer rounded-xl focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        />
        <div className="pointer-events-none relative z-10 flex min-w-0 flex-col gap-3">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-card-foreground">
                {project.title}
              </h3>
              {project.subtitle ? (
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {project.subtitle}
                </p>
              ) : null}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Project actions"
                  className="pointer-events-auto"
                >
                  <MoreVertical />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="pointer-events-auto">
                <DropdownMenuItem onSelect={open}>Open</DropdownMenuItem>
                <DropdownMenuItem onSelect={handleDuplicate} disabled={duplicateMutation.isPending}>
                  <Copy />
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDeleteOpen(true)}>
                  <Trash2 />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {project.authors.length ? (
            <p className="truncate text-xs text-muted-foreground">
              By {project.authors.join(', ')}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-1.5">
            <StatChip icon={FileText} title="Page budget">
              {project.totalPagesBudget} pages
            </StatChip>
            <StatChip icon={Database} title="Attached sources">
              {project.sourcesCount} sources
            </StatChip>
            <StatChip icon={ListTree} title="Outline nodes">
              {project.outlineNodeCount} nodes
            </StatChip>
            {lastRunCost ? (
              <StatChip icon={DollarSign} title="Cost of the last run">
                {lastRunCost}
              </StatChip>
            ) : null}
          </div>

          <div className="flex min-w-0 items-center justify-between gap-2 border-t pt-2.5 text-[11px] text-muted-foreground">
            <span className="flex min-w-0 items-center gap-1.5" title="Created by">
              {project.ownerName ? (
                <span
                  aria-hidden="true"
                  className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-accent text-[9px] font-bold text-accent-foreground"
                >
                  {initialsOf(project.ownerName)}
                </span>
              ) : (
                <UserRound className="size-3.5 shrink-0" />
              )}
              <span className="truncate">{project.ownerName ?? '—'}</span>
            </span>
            <LastRunStatus run={lastRun} hasRun={project.lastRunId !== null} />
          </div>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title={`Delete "${project.title}"?`}
        description="This permanently removes the project, its sources, outline, and run history. This action cannot be undone."
        confirmLabel="Delete project"
        onConfirm={handleDelete}
      />
    </>
  );
}
