import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { ApiError } from '@/api/client';
import { useUpdateOutlineNodeMutation } from '@/api/queries/outline';
import type { MathLevel, OutlineNode } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { NodeSourcesSection } from '@/features/outline/components/node-sources-section';
import { contentLockDisabledReason } from '@/features/outline/content-lock';
import { cn } from '@/lib/utils';

const MATH_LEVELS: { value: MathLevel; label: string }[] = [
  { value: 'introductory', label: 'Introductory' },
  { value: 'rigorous', label: 'Rigorous' },
  { value: 'formal_proof', label: 'Formal proof' },
  { value: 'applied', label: 'Applied' },
];

const DEBOUNCE_MS = 500;

interface NodePropertiesSheetProps {
  projectId: string;
  node: OutlineNode | null;
  /** The project's flat outline — the Sources section resolves inherited scopes through it. */
  flat: readonly OutlineNode[];
  onOpenChange: (open: boolean) => void;
}

/**
 * Self-contained side panel for the CLI-brief fields the mock renders in the
 * copilot drawer's Settings tab — the real copilot drawer doesn't exist yet
 * (#21), so this is a standalone `Sheet` that #21 can later relocate/embed.
 */
export function NodePropertiesSheet({
  projectId,
  node,
  flat,
  onOpenChange,
}: NodePropertiesSheetProps) {
  return (
    <Sheet open={node !== null} onOpenChange={onOpenChange}>
      <SheetContent>
        {node ? (
          <NodePropertiesForm key={node.id} projectId={projectId} node={node} flat={flat} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function NodePropertiesForm({
  projectId,
  node,
  flat,
}: {
  projectId: string;
  node: OutlineNode;
  flat: readonly OutlineNode[];
}) {
  const updateMutation = useUpdateOutlineNodeMutation(projectId, node.id);
  const [targetPages, setTargetPages] = useState(node.targetPages);
  const [equationDensityLevel, setEquationDensityLevel] = useState(node.equationDensityLevel);
  const [subPrompt, setSubPrompt] = useState(node.subPrompt ?? '');
  const [summary, setSummary] = useState(node.summary);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  function patchDebounced(body: Parameters<typeof updateMutation.mutate>[0]) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => updateMutation.mutate(body), DEBOUNCE_MS);
  }

  const contentLockDisabledMessage = contentLockDisabledReason(node, flat);
  let contentLockHelp: string;
  if (node.contentLocked) {
    contentLockHelp =
      'Full runs keep this section byte-for-byte and skip the writer for it. Its text is still handed to the sections generated after it as context, so they stop re-covering it. You can keep editing it here.';
  } else if (contentLockDisabledMessage) {
    contentLockHelp = contentLockDisabledMessage;
  } else {
    contentLockHelp =
      'Keep this section as-is on the next full run instead of rewriting it. Later sections still see its text as context.';
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle>{node.title}</SheetTitle>
        <SheetDescription>
          §{node.sectionNumber} — CLI generation brief for this section.
        </SheetDescription>
      </SheetHeader>

      <div className="custom-scrollbar flex flex-col gap-5 overflow-y-auto px-4 pb-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs font-medium text-foreground">
            <span>Target pages</span>
            <span className="text-muted-foreground">
              {targetPages}p · ~{Math.round(targetPages * 350)} words
            </span>
          </div>
          <Slider
            min={0.5}
            max={30}
            step={0.5}
            value={[targetPages]}
            onValueChange={([value]) => {
              if (value === undefined) return;
              setTargetPages(value);
              patchDebounced({ targetPages: value });
            }}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs font-medium text-foreground">
            <span>Equation density</span>
            <span className="text-muted-foreground">{equationDensityLevel}/5</span>
          </div>
          <Slider
            min={1}
            max={5}
            step={1}
            value={[equationDensityLevel]}
            onValueChange={([value]) => {
              if (value === undefined) return;
              setEquationDensityLevel(value);
              patchDebounced({ equationDensityLevel: value });
            }}
          />
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium text-foreground">Math level</div>
          <div className="grid grid-cols-2 gap-1.5">
            {MATH_LEVELS.map((option) => (
              <Button
                key={option.value}
                type="button"
                size="sm"
                variant={node.mathLevel === option.value ? 'default' : 'outline'}
                className={cn('justify-center')}
                onClick={() => updateMutation.mutate({ mathLevel: option.value })}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-foreground" htmlFor="node-summary">
            Summary (CLI brief)
          </label>
          <Textarea
            id="node-summary"
            rows={3}
            value={summary}
            onChange={(event) => {
              setSummary(event.target.value);
              patchDebounced({ summary: event.target.value });
            }}
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-foreground" htmlFor="node-sub-prompt">
            Sub-prompt
          </label>
          <Textarea
            id="node-sub-prompt"
            rows={3}
            placeholder="Extra instructions for this section only"
            value={subPrompt}
            onChange={(event) => {
              setSubPrompt(event.target.value);
              patchDebounced({ subPrompt: event.target.value });
            }}
          />
        </div>

        <Separator />

        <div className="flex items-start justify-between gap-3 rounded-lg border bg-muted/30 p-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground" htmlFor="node-content-locked">
              Lock content
            </label>
            <p className="text-[11px] leading-snug text-muted-foreground">{contentLockHelp}</p>
          </div>
          <Switch
            id="node-content-locked"
            aria-label="Lock content"
            checked={node.contentLocked}
            disabled={Boolean(contentLockDisabledMessage)}
            onCheckedChange={(checked) =>
              updateMutation.mutate(
                { contentLocked: checked },
                {
                  onError: (error) => {
                    const problem = error instanceof ApiError ? error.problem : undefined;
                    toast.error(
                      problem?.detail ?? problem?.title ?? 'Could not change the content lock',
                    );
                  },
                },
              )
            }
          />
        </div>

        <Separator />

        <NodeSourcesSection projectId={projectId} node={node} flat={flat} />
      </div>
    </>
  );
}
