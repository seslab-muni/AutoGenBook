import { useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Copy, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import {
  useDeleteProjectMutation,
  useDuplicateProjectMutation,
  useUpdateProjectMutation,
} from '@/api/queries/projects';
import type { Project } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
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
  formValuesToUpdate,
  isProjectFormValid,
  projectToFormValues,
} from '@/features/projects/lib/project-form';
import { useUiStore } from '@/stores/ui-store';

interface ProjectSettingsDialogProps {
  project: Project;
}

/** Mounted in the project layout (`p.$projectId.tsx`); `AppHeader`'s Settings action opens it. */
export function ProjectSettingsDialog({ project }: ProjectSettingsDialogProps) {
  const activeModal = useUiStore((state) => state.activeModal);
  const closeModal = useUiStore((state) => state.closeModal);
  const open = activeModal === 'settings';
  const navigate = useNavigate();
  const [values, setValues] = useState(() => projectToFormValues(project));
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const updateMutation = useUpdateProjectMutation(project.id);
  const duplicateMutation = useDuplicateProjectMutation(project.id);
  const deleteMutation = useDeleteProjectMutation(project.id);

  // Reset the form every time the dialog opens for a given project (adjusting state during
  // render, per https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)
  // rather than in a useEffect, which would render stale/mismatched field values for one frame first.
  const resetKey = open ? project.id : null;
  const [lastResetKey, setLastResetKey] = useState<string | null>(null);
  if (resetKey !== lastResetKey) {
    setLastResetKey(resetKey);
    if (resetKey !== null) {
      setValues(projectToFormValues(project));
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!isProjectFormValid(values)) return;
    updateMutation.mutate(formValuesToUpdate(values), {
      onSuccess: () => {
        toast.success('Project settings saved');
        closeModal();
      },
    });
  }

  function handleDuplicate() {
    duplicateMutation.mutate(undefined, {
      onSuccess: (copy) => {
        toast.success(`Duplicated as "${copy.title}"`);
        closeModal();
        void navigate({ to: '/p/$projectId', params: { projectId: copy.id } });
      },
    });
  }

  function handleDelete() {
    deleteMutation.mutate(undefined, {
      onSuccess: () => {
        toast.success('Project deleted');
        closeModal();
        void navigate({ to: '/' });
      },
    });
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && closeModal()}>
        <DialogContent className="custom-scrollbar max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Project settings</DialogTitle>
            <DialogDescription>
              Generation bounds, math rigor, and outline depth for this project.
            </DialogDescription>
          </DialogHeader>
          <form id="project-settings-form" onSubmit={handleSubmit}>
            <ProjectFormFields
              idPrefix="project-settings"
              values={values}
              onChange={(patch) => setValues((current) => ({ ...current, ...patch }))}
            />
          </form>
          <DialogFooter className="sm:justify-between">
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleDuplicate}
                disabled={duplicateMutation.isPending}
              >
                <Copy />
                Duplicate
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmDeleteOpen(true)}
              >
                <Trash2 />
                Delete
              </Button>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={closeModal}>
                Cancel
              </Button>
              <Button
                type="submit"
                form="project-settings-form"
                disabled={!isProjectFormValid(values) || updateMutation.isPending}
              >
                {updateMutation.isPending ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
