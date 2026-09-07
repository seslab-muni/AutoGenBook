import type {
  AudienceLevel,
  OutputFormat,
  Project,
  ProjectCreate,
  ProjectUpdate,
} from '@/api/types';

/** Editable project metadata, as controlled form state (`authors` is a raw comma-separated string). */
export interface ProjectFormValues {
  title: string;
  subtitle: string;
  topic: string;
  authors: string;
  targetAudience: AudienceLevel;
  outputFormat: OutputFormat;
  totalPagesBudget: number;
  equationFrequencyLevel: number;
  maxOutlineLevels: number;
  doConsiderOutline: boolean;
  doConsiderPreviousSections: boolean;
}

export const DEFAULT_PROJECT_FORM_VALUES: ProjectFormValues = {
  title: '',
  subtitle: '',
  topic: '',
  authors: '',
  targetAudience: 'graduate',
  outputFormat: 'markdown',
  totalPagesBudget: 350,
  equationFrequencyLevel: 4,
  maxOutlineLevels: 3,
  doConsiderOutline: true,
  doConsiderPreviousSections: true,
};

export function projectToFormValues(project: Project): ProjectFormValues {
  return {
    title: project.title,
    subtitle: project.subtitle,
    topic: project.topic,
    authors: project.authors.join(', '),
    targetAudience: project.targetAudience,
    outputFormat: project.outputFormat,
    totalPagesBudget: project.totalPagesBudget,
    equationFrequencyLevel: project.equationFrequencyLevel,
    maxOutlineLevels: project.maxOutlineLevels,
    doConsiderOutline: project.doConsiderOutline,
    doConsiderPreviousSections: project.doConsiderPreviousSections,
  };
}

function splitAuthors(raw: string): string[] {
  return raw
    .split(',')
    .map((author) => author.trim())
    .filter(Boolean);
}

/** `title`/`subtitle`/`topic` non-empty and at least one author — the fields the API requires. */
export function isProjectFormValid(values: ProjectFormValues): boolean {
  return (
    values.title.trim() !== '' &&
    values.subtitle.trim() !== '' &&
    values.topic.trim() !== '' &&
    splitAuthors(values.authors).length > 0
  );
}

function sharedFields(values: ProjectFormValues) {
  return {
    title: values.title.trim(),
    subtitle: values.subtitle.trim(),
    topic: values.topic.trim(),
    authors: splitAuthors(values.authors),
    targetAudience: values.targetAudience,
    outputFormat: values.outputFormat,
    totalPagesBudget: values.totalPagesBudget,
    equationFrequencyLevel: values.equationFrequencyLevel,
    maxOutlineLevels: values.maxOutlineLevels,
    doConsiderOutline: values.doConsiderOutline,
    doConsiderPreviousSections: values.doConsiderPreviousSections,
  };
}

export function formValuesToCreate(values: ProjectFormValues): ProjectCreate {
  return sharedFields(values);
}

export function formValuesToUpdate(values: ProjectFormValues): ProjectUpdate {
  return sharedFields(values);
}
