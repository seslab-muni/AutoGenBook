import { useCallback, useState, type FormEvent } from 'react';
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
import { ProjectFormFields } from '@/features/projects/components/project-form-fields';
import {
  DEFAULT_PROJECT_FORM_VALUES,
  formValuesToCreate,
  isProjectFormValid,
} from '@/features/projects/lib/project-form';
import type { ProjectFormValues } from '@/features/projects/lib/project-form';
import { SourcePicker } from '@/features/sources/components/source-picker';
import type { PendingSource } from '@/features/sources/lib/pending-source';
import { toSourceCreate } from '@/features/sources/lib/pending-source';
import { useUiStore } from '@/stores/ui-store';

/**
 * Mounted once at the root layout so it's reachable both from the projects hub and from
 * `AppHeader`'s "New Project" action while inside a project. Outline authoring at creation time
 * is still out of scope (lands with #19); sources can now be attached via `SourcePicker` (#18).
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

  // Stable identity (issue #128 review) so `ProjectFormFields`'s own `useCallback`-wrapped
  // `ModelSelect` handler - and `memo`'d `ModelSelect` itself - don't see a fresh function on
  // every keystroke; the functional update form means it needs no dependencies.
  const handleFormChange = useCallback((patch: Partial<ProjectFormValues>) => {
    setValues((current) => ({ ...current, ...patch }));
  }, []);

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

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeModal()}>
      <DialogContent className="custom-scrollbar max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Set up the generation parameters and optionally attach sources. The outline can be added
            once the project exists.
          </DialogDescription>
        </DialogHeader>
        <form id="new-project-form" onSubmit={handleSubmit}>
          <ProjectFormFields idPrefix="new-project" values={values} onChange={handleFormChange} />
        </form>
        <div className="space-y-1.5 border-t pt-4">
          <p className="text-xs font-semibold text-foreground">Sources (optional)</p>
          <SourcePicker value={pendingSources} onChange={setPendingSources} />
        </div>
        <DialogFooter>
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
