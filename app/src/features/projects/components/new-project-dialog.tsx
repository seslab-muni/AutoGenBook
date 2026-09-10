import { useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';

import { useCreateProjectMutation } from '@/api/queries/projects';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ProjectBasicsFields,
  ProjectGenerationFields,
} from '@/features/projects/components/project-form-fields';
import {
  DEFAULT_PROJECT_FORM_VALUES,
  formValuesToCreate,
  isProjectFormValid,
} from '@/features/projects/lib/project-form';
import { SourcePicker } from '@/features/sources/components/source-picker';
import type { PendingSource } from '@/features/sources/lib/pending-source';
import { toSourceCreate } from '@/features/sources/lib/pending-source';
import { useUiStore } from '@/stores/ui-store';

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
      {children}
    </h3>
  );
}

/**
 * Mounted once at the root layout so it's reachable both from the projects hub and from
 * `AppHeader`'s "New Project" action while inside a project. Outline authoring at creation time
 * is still out of scope (lands with #19); sources can now be attached via `SourcePicker` (#18).
 *
 * Laid out as two columns on `md+` (book metadata left; generation settings and sources right)
 * so the whole form fits without scrolling on a laptop screen — the single-column version used
 * to push Cancel/Create below the fold at 1080p.
 */
export function NewProjectDialog() {
  const activeModal = useUiStore((state) => state.activeModal);
  const closeModal = useUiStore((state) => state.closeModal);
  const open = activeModal === 'new-project';
  const navigate = useNavigate();
  const [values, setValues] = useState(DEFAULT_PROJECT_FORM_VALUES);
  const [pendingSources, setPendingSources] = useState<PendingSource[]>([]);
  const createMutation = useCreateProjectMutation();

  // Reset the form every time the dialog opens (adjusting state during render, per
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)
  // rather than in a useEffect, which would render the stale form for one frame first.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setValues(DEFAULT_PROJECT_FORM_VALUES);
      setPendingSources([]);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!isProjectFormValid(values)) return;
    createMutation.mutate(
      { ...formValuesToCreate(values), sources: toSourceCreate(pendingSources) },
      {
        onSuccess: (project) => {
          toast.success(`"${project.title}" created`);
          closeModal();
          void navigate({ to: '/p/$projectId', params: { projectId: project.id } });
        },
      },
    );
  }

  const fieldProps = {
    idPrefix: 'new-project',
    values,
    onChange: (patch: Partial<typeof values>) => setValues((current) => ({ ...current, ...patch })),
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeModal()}>
      <DialogContent className="custom-scrollbar max-h-[calc(100vh-3rem)] overflow-y-auto sm:max-w-[min(1200px,calc(100vw-4rem))]">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Describe the book, tune generation, and optionally attach sources. The outline is
            drafted once the project exists.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-8 md:grid-cols-2">
          {/* `contents`: the form spans both columns' project fields without becoming a grid
              item itself, while `SourcePicker` stays *outside* it so pressing Enter in a
              source's authors/year input can't submit the whole project. */}
          <form id="new-project-form" onSubmit={handleSubmit} className="contents">
            <section className="space-y-4 md:row-span-2">
              <SectionLabel>About the book</SectionLabel>
              <ProjectBasicsFields {...fieldProps} />
            </section>
            <section className="space-y-4">
              <SectionLabel>Generation</SectionLabel>
              <ProjectGenerationFields {...fieldProps} />
            </section>
          </form>
          <section className="space-y-3 md:col-start-2">
            <SectionLabel>
              Sources <span className="font-medium tracking-normal normal-case">(optional)</span>
            </SectionLabel>
            <SourcePicker value={pendingSources} onChange={setPendingSources} compact />
          </section>
        </div>

        <DialogFooter className="border-t pt-4">
          <Button type="button" variant="outline" onClick={closeModal}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="new-project-form"
            disabled={!isProjectFormValid(values) || createMutation.isPending}
          >
            {createMutation.isPending ? 'Creating…' : 'Create project'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
