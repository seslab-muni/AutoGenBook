import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';

import { ApiError } from '@/api/client';
import { outline } from '@/api/queries/outline';
import { useCreateRunMutation } from '@/api/queries/runs';
import type { AuditMode, OutputFormat, Project, RunOptions } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { OUTPUT_FORMAT_LABELS } from '@/features/projects/lib/labels';
import { useUiStore } from '@/stores/ui-store';

const AUDIT_MODE_LABELS: Record<AuditMode, string> = {
  off: 'Off — skip citation/figure/claim checks',
  warn: 'Warn — flag issues, still emit output',
  strict: 'Strict — block PDF emission on errors',
};
const AUDIT_MODE_OPTIONS = Object.keys(AUDIT_MODE_LABELS) as AuditMode[];
const OUTPUT_FORMAT_OPTIONS = Object.keys(OUTPUT_FORMAT_LABELS) as OutputFormat[];

interface StartRunDialogProps {
  project: Project;
}

/**
 * Form over `RunOptions` (`docs/openapi.yaml`'s `POST /projects/{id}/runs`
 * body) — opened from `AppHeader`'s Run action and the outline pane's
 * empty state. `outline` only ever sends `"project"`: the generated schema
 * (`src/api/schema.gen.ts`'s `RunOptions.outline`) has no other member yet,
 * so a planner-authored outline source (mentioned in issue #21) isn't a
 * real option until the API adds one — shown here as a fixed, disabled
 * choice rather than invented.
 */
export function StartRunDialog({ project }: StartRunDialogProps) {
  const activeModal = useUiStore((state) => state.activeModal);
  const closeModal = useUiStore((state) => state.closeModal);
  const openModal = useUiStore((state) => state.openModal);
  const open = activeModal === 'start-run';
  const navigate = useNavigate();

  const { data: outlineData } = useQuery({
    ...outline.flat(project.id, { limit: 500 }),
    enabled: open,
  });
  const nodeCount = outlineData?.total ?? 0;

  const [outputFormat, setOutputFormat] = useState<OutputFormat>(project.outputFormat);
  const [allowSubdivision, setAllowSubdivision] = useState(false);
  const [auditBookMode, setAuditBookMode] = useState<AuditMode>('warn');

  const createMutation = useCreateRunMutation(project.id);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setOutputFormat(project.outputFormat);
      setAllowSubdivision(false);
      setAuditBookMode('warn');
    }
  }

  function handleSubmit() {
    const body: RunOptions = { outline: 'project', outputFormat, allowSubdivision, auditBookMode };
    createMutation.mutate(body, {
      onSuccess: (run) => {
        toast.success('Run queued');
        closeModal();
        void navigate({
          to: '/p/$projectId/runs/$runId',
          params: { projectId: project.id, runId: run.id },
        });
      },
      onError: (error) => {
        if (error instanceof ApiError && error.status === 409) {
          toast.error(error.problem?.title ?? 'A run is already active for this project', {
            description: error.problem?.detail ?? undefined,
            action: {
              label: 'View it',
              onClick: () => {
                closeModal();
                openModal('run-history');
              },
            },
          });
          return;
        }
        const problem = error instanceof ApiError ? error.problem : undefined;
        toast.error(problem?.detail ?? problem?.title ?? 'Could not start the run');
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeModal()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Start a run</DialogTitle>
          <DialogDescription>
            Runs the CLI over this project's current outline and sources. Only one run can be active
            per project at a time.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Estimated size:</span> {nodeCount} outline
            node{nodeCount === 1 ? '' : 's'} · ~{project.totalPagesBudget} pages
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-foreground" htmlFor="start-run-outline">
                Outline source
              </label>
              <Select value="project" disabled>
                <SelectTrigger id="start-run-outline" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="project">This project&apos;s outline</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-foreground" htmlFor="start-run-format">
                Output format
              </label>
              <Select
                value={outputFormat}
                onValueChange={(value) => setOutputFormat(value as OutputFormat)}
              >
                <SelectTrigger id="start-run-format" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OUTPUT_FORMAT_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {OUTPUT_FORMAT_LABELS[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground" htmlFor="start-run-audit">
              Audit mode
            </label>
            <Select
              value={auditBookMode}
              onValueChange={(value) => setAuditBookMode(value as AuditMode)}
            >
              <SelectTrigger id="start-run-audit" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUDIT_MODE_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {AUDIT_MODE_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <label className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-xs font-medium text-foreground">
            <Checkbox
              checked={allowSubdivision}
              onCheckedChange={(checked) => setAllowSubdivision(checked === true)}
            />
            <span>
              Allow subdivision
              <span className="mt-0.5 block font-normal text-muted-foreground">
                Lets the CLI split oversized, unlocked leaf sections into more nodes as it drafts.
              </span>
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={closeModal}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Starting…' : 'Start run'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
