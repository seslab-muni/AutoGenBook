import { useEffect, useRef, useState } from 'react';

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
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
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
  onOpenChange: (open: boolean) => void;
}

/**
 * Self-contained side panel for the CLI-brief fields the mock renders in the
 * copilot drawer's Settings tab — the real copilot drawer doesn't exist yet
 * (#21), so this is a standalone `Sheet` that #21 can later relocate/embed.
 */
export function NodePropertiesSheet({ projectId, node, onOpenChange }: NodePropertiesSheetProps) {
  return (
    <Sheet open={node !== null} onOpenChange={onOpenChange}>
      <SheetContent>
        {node ? <NodePropertiesForm key={node.id} projectId={projectId} node={node} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function NodePropertiesForm({
  projectId,
  node,
}: {
  projectId: string;
  node: OutlineNode;
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

  return (
    <>
      <SheetHeader>
        <SheetTitle>{node.title}</SheetTitle>
        <SheetDescription>
          §{node.sectionNumber} — CLI generation brief for this section.
        </SheetDescription>
      </SheetHeader>

      <div className="flex flex-col gap-5 overflow-y-auto px-4 pb-4">
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
      </div>
    </>
  );
}
