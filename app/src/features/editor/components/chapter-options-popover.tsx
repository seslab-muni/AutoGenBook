import { useEffect, useRef, useState } from 'react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';

import { useUpdateOutlineNodeMutation } from '@/api/queries/outline';
import type { MathLevel, OutlineNode, OutlineNodeUpdate } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { NodeSourcesSection } from '@/features/outline/components/node-sources-section';

const MATH_LEVELS: { value: MathLevel; label: string }[] = [
  { value: 'introductory', label: 'Introductory' },
  { value: 'rigorous', label: 'Rigorous' },
  { value: 'formal_proof', label: 'Formal proof' },
  { value: 'applied', label: 'Applied' },
];

const DEBOUNCE_MS = 500;

interface ChapterOptionsPopoverProps {
  projectId: string;
  node: OutlineNode;
  /** The project's flat outline — the Sources section resolves inherited scopes through it. */
  flat: readonly OutlineNode[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open with focus on the Sources section (scrolled into view) instead of the first field. */
  focusSources?: boolean;
}

/**
 * The editor header's "Chapter options" chip and its popover: the section's standing generation
 * brief (target pages, equation density, math level, summary, sub-prompt) plus its source scope.
 * Every field saves as it changes (sliders and text debounced, buttons immediate) — there is no
 * Save button. Replaces the outline row's Properties sheet (issue #182).
 */
export function ChapterOptionsPopover({
  projectId,
  node,
  flat,
  open,
  onOpenChange,
  focusSources = false,
}: ChapterOptionsPopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="rounded-full">
          <SlidersHorizontal />
          <span className="max-xl:sr-only">Chapter options</span>
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Chapter options"
        onOpenAutoFocus={(event) => {
          if (!focusSources) return;
          const section =
            event.currentTarget instanceof HTMLElement
              ? event.currentTarget.querySelector('[data-sources-section]')
              : null;
          const target = section?.querySelector<HTMLElement>(
            '[role="radio"][aria-checked="true"], [role="radio"]',
          );
          if (!target) return;
          event.preventDefault();
          target.focus();
          target.scrollIntoView?.({ block: 'nearest' });
        }}
        className="custom-scrollbar max-h-[min(36rem,var(--radix-popover-content-available-height))] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto"
      >
        <ChapterOptionsForm projectId={projectId} node={node} flat={flat} />
      </PopoverContent>
    </Popover>
  );
}

function ChapterOptionsForm({
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
  // Fields edited since the last debounced PATCH — merged, so closing the popover mid-debounce
  // still saves everything instead of dropping it.
  const pendingRef = useRef<OutlineNodeUpdate>({});
  const mutateRef = useRef(updateMutation.mutate);
  useEffect(() => {
    mutateRef.current = updateMutation.mutate;
  }, [updateMutation.mutate]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (Object.keys(pendingRef.current).length > 0) mutateRef.current(pendingRef.current);
    };
  }, []);

  function patchDebounced(body: OutlineNodeUpdate) {
    pendingRef.current = { ...pendingRef.current, ...body };
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const pending = pendingRef.current;
      pendingRef.current = {};
      updateMutation.mutate(pending);
    }, DEBOUNCE_MS);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-0.5">
        <div className="flex items-baseline justify-between gap-2 text-sm font-medium">
          <span>Chapter options</span>
          <span className="text-[11px] font-normal text-muted-foreground">
            §{node.sectionNumber}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Standing instructions every run and rewrite of this section reads.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs font-medium text-foreground">
          <span>Target pages</span>
          <span className="text-muted-foreground">
            {targetPages}p · ~{Math.round(targetPages * 350)} words
          </span>
        </div>
        <Slider
          thumbLabels={['Target pages']}
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
          thumbLabels={['Equation density']}
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
              aria-pressed={node.mathLevel === option.value}
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

      <NodeSourcesSection projectId={projectId} node={node} flat={flat} />
    </div>
  );
}
