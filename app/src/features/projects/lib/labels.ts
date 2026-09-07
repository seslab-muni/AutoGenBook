import type { AudienceLevel, OutputFormat } from '@/api/types';

export const AUDIENCE_LABELS: Record<AudienceLevel, string> = {
  undergraduate: 'Undergraduate',
  graduate: 'Graduate',
  phd_researcher: 'PhD / researcher',
  industry_practitioner: 'Industry practitioner',
};

export const OUTPUT_FORMAT_LABELS: Record<OutputFormat, string> = {
  markdown: 'Markdown',
  latex: 'LaTeX',
  pdf: 'PDF',
};
