import { useCallback } from 'react';

import type { AudienceLevel, OutputFormat } from '@/api/types';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ModelSelect } from '@/components/model-select';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { AUDIENCE_LABELS, OUTPUT_FORMAT_LABELS } from '@/features/projects/lib/labels';
import type { ProjectFormValues } from '@/features/projects/lib/project-form';

const AUDIENCE_OPTIONS = Object.keys(AUDIENCE_LABELS) as AudienceLevel[];
const OUTPUT_FORMAT_OPTIONS = Object.keys(OUTPUT_FORMAT_LABELS) as OutputFormat[];
const LEVEL_OPTIONS = [1, 2, 3, 4, 5] as const;

interface ProjectFormFieldsProps {
  values: ProjectFormValues;
  onChange: (patch: Partial<ProjectFormValues>) => void;
  idPrefix: string;
}

/** Title / subtitle / topic / authors — what the book *is*. */
export function ProjectBasicsFields({ values, onChange, idPrefix }: ProjectFormFieldsProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor={`${idPrefix}-title`} className="text-xs font-semibold text-foreground">
          Title
        </label>
        <Input
          id={`${idPrefix}-title`}
          value={values.title}
          onChange={(event) => onChange({ title: event.target.value })}
          placeholder="e.g. Statistical Mechanics & Non-Equilibrium Field Theory"
          required
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor={`${idPrefix}-subtitle`} className="text-xs font-semibold text-foreground">
          Subtitle
        </label>
        <Input
          id={`${idPrefix}-subtitle`}
          value={values.subtitle}
          onChange={(event) => onChange({ subtitle: event.target.value })}
          placeholder="e.g. A Graduate Treatise on Renormalization and Critical Phenomena"
          required
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor={`${idPrefix}-topic`} className="text-xs font-semibold text-foreground">
          Topic
        </label>
        <Textarea
          id={`${idPrefix}-topic`}
          value={values.topic}
          onChange={(event) => onChange({ topic: event.target.value })}
          placeholder="What should the generated content focus on?"
          rows={2}
          required
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor={`${idPrefix}-authors`} className="text-xs font-semibold text-foreground">
          Authors
        </label>
        <Input
          id={`${idPrefix}-authors`}
          value={values.authors}
          onChange={(event) => onChange({ authors: event.target.value })}
          placeholder="Comma-separated, e.g. Ada Lovelace, Alan Turing"
          required
        />
      </div>
    </div>
  );
}

/** Audience / format / budgets / depth / context flags — how the book is *generated*. */
export function ProjectGenerationFields({ values, onChange, idPrefix }: ProjectFormFieldsProps) {
  // `ModelSelect` is wrapped in `memo` (issue #128 review) precisely so that typing in an
  // unrelated field here (title, topic, ...) doesn't re-render it and rebuild its
  // hundreds-of-entries `<datalist>` on every keystroke - that only holds if this handler's own
  // identity stays stable across those re-renders too, which requires `onChange` itself (passed
  // in by the dialog that owns the form's state) to be a stable reference.
  const handleModelChange = useCallback((value: string) => onChange({ llmModel: value }), [onChange]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground" htmlFor={`${idPrefix}-audience`}>
            Target audience
          </label>
          <Select
            value={values.targetAudience}
            onValueChange={(value) => onChange({ targetAudience: value as AudienceLevel })}
          >
            <SelectTrigger id={`${idPrefix}-audience`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUDIENCE_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {AUDIENCE_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground" htmlFor={`${idPrefix}-format`}>
            Output format
          </label>
          <Select
            value={values.outputFormat}
            onValueChange={(value) => onChange({ outputFormat: value as OutputFormat })}
          >
            <SelectTrigger id={`${idPrefix}-format`} className="w-full">
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
        <label className="text-xs font-semibold text-foreground" htmlFor={`${idPrefix}-model`}>
          LLM model
        </label>
        <ModelSelect
          id={`${idPrefix}-model`}
          value={values.llmModel}
          onChange={handleModelChange}
          placeholder="Deployment default"
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground" htmlFor={`${idPrefix}-pages`}>
            Page budget
          </label>
          <Input
            id={`${idPrefix}-pages`}
            type="number"
            min={5}
            max={2000}
            step={5}
            value={values.totalPagesBudget}
            onChange={(event) =>
              onChange({ totalPagesBudget: Number(event.target.value) || DEFAULT_MIN_PAGES })
            }
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground" htmlFor={`${idPrefix}-eq`}>
            Equation density
          </label>
          <Select
            value={String(values.equationFrequencyLevel)}
            onValueChange={(value) => onChange({ equationFrequencyLevel: Number(value) })}
          >
            <SelectTrigger id={`${idPrefix}-eq`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEVEL_OPTIONS.map((level) => (
                <SelectItem key={level} value={String(level)}>
                  Level {level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground" htmlFor={`${idPrefix}-depth`}>
            Outline depth
          </label>
          <Select
            value={String(values.maxOutlineLevels)}
            onValueChange={(value) => onChange({ maxOutlineLevels: Number(value) })}
          >
            <SelectTrigger id={`${idPrefix}-depth`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEVEL_OPTIONS.map((level) => (
                <SelectItem key={level} value={String(level)}>
                  Level {level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
        <label className="flex items-center gap-2 text-xs font-medium text-foreground">
          <Checkbox
            checked={values.doConsiderOutline}
            onCheckedChange={(checked) => onChange({ doConsiderOutline: checked === true })}
          />
          Consider the global outline when drafting each section
        </label>
        <label className="flex items-center gap-2 text-xs font-medium text-foreground">
          <Checkbox
            checked={values.doConsiderPreviousSections}
            onCheckedChange={(checked) =>
              onChange({ doConsiderPreviousSections: checked === true })
            }
          />
          Pass preceding section context to the writer agent
        </label>
      </div>
    </div>
  );
}

/** All metadata fields in one column — the project settings dialog. The new-project dialog
 * places `ProjectBasicsFields` and `ProjectGenerationFields` side by side instead. */
export function ProjectFormFields(props: ProjectFormFieldsProps) {
  return (
    <div className="space-y-4">
      <ProjectBasicsFields {...props} />
      <ProjectGenerationFields {...props} />
    </div>
  );
}

const DEFAULT_MIN_PAGES = 5;
