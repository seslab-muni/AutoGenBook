import { useState } from 'react';
import { ListTree } from 'lucide-react';
import { toast } from 'sonner';

import { useUpdateOutlineNodesMutation } from '@/api/queries/outline';
import type { OutlineNode } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatSectionList } from '@/features/outline/source-scope';

interface AssignToChaptersPopoverProps {
  projectId: string;
  /** Top-level outline nodes, in outline order. */
  chapters: readonly OutlineNode[];
  /** The sources being assigned (the dialog's current bulk selection). */
  sourceIds: readonly string[];
}

/**
 * `SourcesDialog`'s bulk "Assign to chapters…" action (issue #138): adds the selected sources to
 * each checked chapter's own selection — a chapter already on "Only selected" keeps its current
 * sources too; one on "All project sources"/inherit switches to just these.
 */
export function AssignToChaptersPopover({
  projectId,
  chapters,
  sourceIds,
}: AssignToChaptersPopoverProps) {
  const [open, setOpen] = useState(false);
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(() => new Set());
  const mutation = useUpdateOutlineNodesMutation(projectId);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) setCheckedIds(new Set());
  }

  function toggle(id: string, checked: boolean) {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function assign() {
    const targets = chapters.filter((chapter) => checkedIds.has(chapter.id));
    const updates = targets.map((chapter) => ({
      nodeId: chapter.id,
      body: {
        sourceScope: 'selected' as const,
        sourceIds: [
          ...new Set([
            ...(chapter.sourceScope === 'selected' ? chapter.sourceIds : []),
            ...sourceIds,
          ]),
        ],
      },
    }));
    mutation.mutate(updates, {
      onSuccess: ({ succeeded, failed }) => {
        if (succeeded > 0) {
          toast.success(
            `Assigned ${sourceIds.length} ${sourceIds.length === 1 ? 'source' : 'sources'} to ${formatSectionList(targets)}`,
          );
        }
        if (failed > 0) {
          toast.error(`Could not update ${failed} ${failed === 1 ? 'chapter' : 'chapters'}`);
        }
        setOpen(false);
      },
    });
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={chapters.length === 0}>
          <ListTree />
          Assign to chapters…
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" aria-label="Assign to chapters">
        <div className="space-y-0.5 border-b px-3 py-2.5">
          <p className="text-xs font-semibold text-foreground">
            Add {sourceIds.length} {sourceIds.length === 1 ? 'source' : 'sources'} to…
          </p>
          <p className="text-[11px] text-muted-foreground">
            Chapters on &ldquo;All project sources&rdquo; switch to &ldquo;Only selected&rdquo;.
          </p>
        </div>
        <ul className="custom-scrollbar max-h-64 overflow-y-auto p-1">
          {chapters.map((chapter) => {
            const inputId = `assign-chapter-${chapter.id}`;
            const hint =
              chapter.sourceScope === 'selected'
                ? `${chapter.sourceIds.length} selected`
                : 'all sources';
            return (
              <li key={chapter.id}>
                <label
                  htmlFor={inputId}
                  className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-xs hover:bg-muted/50"
                >
                  <Checkbox
                    id={inputId}
                    checked={checkedIds.has(chapter.id)}
                    onCheckedChange={(next) => toggle(chapter.id, next === true)}
                    aria-label={`§${chapter.sectionNumber} ${chapter.title}`}
                  />
                  <span className="shrink-0 font-mono text-[11px] font-semibold text-muted-foreground">
                    {chapter.sectionNumber}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{chapter.title}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{hint}</span>
                </label>
              </li>
            );
          })}
        </ul>
        <div className="flex justify-end gap-2 border-t px-3 py-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={checkedIds.size === 0 || mutation.isPending}
            onClick={assign}
          >
            Assign
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
