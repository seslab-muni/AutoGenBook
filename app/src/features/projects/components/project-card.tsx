import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Copy, Database, FileText, ListTree, MoreVertical, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { useDeleteProjectMutation, useDuplicateProjectMutation } from '@/api/queries/projects';
import type { ProjectSummary } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface ProjectCardProps {
  project: ProjectSummary;
}

export function ProjectCard({ project }: ProjectCardProps) {
  const navigate = useNavigate();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const duplicateMutation = useDuplicateProjectMutation(project.id);
  const deleteMutation = useDeleteProjectMutation(project.id);

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
      <Card
        role="button"
        tabIndex={0}
        aria-label={`Open ${project.title}`}
        onClick={open}
        onKeyDown={(event) => {
          if (event.key === 'Enter') open();
        }}
        className="cursor-pointer gap-4 py-4 transition-colors hover:border-primary/50 hover:shadow-md"
      >
        <CardHeader className="px-4">
          {/* `min-w-0`: this row is a CSS grid item (CardHeader's default `grid`), which
              defaults to `min-width: auto` — without it, the row refuses to shrink below
              its content's natural width and overflows the card into its neighbor. */}
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
                  onClick={(event) => event.stopPropagation()}
                >
                  <MoreVertical />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
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
        </CardHeader>
        <CardContent className="flex items-center gap-3 px-4 text-xs text-muted-foreground">
          {project.authors.length ? (
            <span className="min-w-0 flex-1 truncate">By {project.authors.join(', ')}</span>
          ) : null}
          <span className="flex shrink-0 items-center gap-1">
            <FileText className="size-3.5" />
            {project.totalPagesBudget}p
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <Database className="size-3.5" />
            {project.sourcesCount}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <ListTree className="size-3.5" />
            {project.outlineNodeCount}
          </span>
        </CardContent>
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
