import type { RunOptionsOut } from '@/api/types';

/** A fully-populated `RunOptionsOut` for tests that don't care about specific option values, just a valid `Run.options`. */
export const DEFAULT_RUN_OPTIONS: RunOptionsOut = {
  outline: 'project',
  outputFormat: 'markdown',
  allowSubdivision: true,
  enableWebRag: false,
  auditBook: false,
  auditBookMode: 'warn',
  legacyTex: false,
  rebuildKb: false,
  failFastSchema: false,
  resume: false,
  exportTexOnly: false,
  llmModel: 'openai/gpt-5-mini',
};
