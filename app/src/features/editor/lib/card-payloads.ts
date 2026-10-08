import type { Comment } from '@/api/types';

/**
 * Typed views of the API's free-form `payload` objects (`kind=review`, `kind=suggestion`) and of
 * `OutlineNode.reviewSummary`. The API types them as open objects, so every reader here is
 * defensive: a missing or malformed key falls back to a harmless default instead of throwing in a
 * render.
 */

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ------------------------------------------------------------------ review rows

export type ReviewSeverity = 'major' | 'minor';
export type ReviewSource = 'reviewer' | 'consistency' | 'citation';

export interface ReviewPayload {
  /** The reviewer's issue type (`coverage`, `terminology`, `consistency:term`, ...). */
  type: string;
  severity: ReviewSeverity;
  requiredFix: string;
  /** A literal replacement inside the quote; both set, or the chips are not shown. */
  replaceFrom: string;
  replaceTo: string;
  source: ReviewSource;
  /** A newer review no longer reports this issue, but replies keep it as history. */
  outdated: boolean;
}

export function reviewPayload(comment: Pick<Comment, 'payload'>): ReviewPayload {
  const payload = record(comment.payload);
  const source = str(payload['source']);
  return {
    type: str(payload['type'], 'issue'),
    // The server folds every severity into these two, with minor as its default.
    severity: payload['severity'] === 'major' ? 'major' : 'minor',
    requiredFix: str(payload['requiredFix']),
    replaceFrom: str(payload['replaceFrom']),
    replaceTo: str(payload['replaceTo']),
    source: source === 'consistency' || source === 'citation' ? source : 'reviewer',
    outdated: payload['outdated'] === true,
  };
}

/** `consistency:term` -> `Consistency: term`; `coverage` -> `Coverage`. */
export function reviewTypeLabel(type: string): string {
  const [head = '', ...rest] = type.replace(/_/g, ' ').split(':');
  const first = head.charAt(0).toUpperCase() + head.slice(1);
  return rest.length > 0 ? `${first}: ${rest.join(':').trim()}` : first;
}

export interface ReviewSummary {
  okToKeep: boolean;
  issueCount: number;
  suggestedEdits: string[];
  retrievalQueries: string[];
  reviewedAt: string | null;
}

/** `OutlineNode.reviewSummary`: `null` = never reviewed. */
export function parseReviewSummary(raw: unknown): ReviewSummary | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const summary = raw as Record<string, unknown>;
  return {
    okToKeep: summary['okToKeep'] === true,
    issueCount: typeof summary['issueCount'] === 'number' ? summary['issueCount'] : 0,
    suggestedEdits: strings(summary['suggestedEdits']),
    retrievalQueries: strings(summary['retrievalQueries']),
    reviewedAt: typeof summary['reviewedAt'] === 'string' ? summary['reviewedAt'] : null,
  };
}

// ------------------------------------------------------------------ suggestions

/** One changed span of the original section text (offsets are Unicode code points). */
export interface Hunk {
  start: number;
  end: number;
  removed: string;
  added: string;
}

export interface SuggestionError {
  code: string;
  message: string;
}

export interface SuggestionParams {
  moreProofs: boolean;
  moreExamples: boolean;
  moreRigorous: boolean;
  shorter: boolean;
  longer: boolean;
  citeSources: boolean;
  fixIssueIds: string[];
  addressCommentIds: string[];
}

export interface SuggestionPayload {
  verb: 'revise' | 'rewrite';
  scope: 'section' | 'range';
  instruction: string;
  params: SuggestionParams;
  threadId: string | null;
  baseContentHash: string | null;
  originalMarkdown: string | null;
  replacementMarkdown: string | null;
  hunks: Hunk[];
  summary: string;
  changesMade: string[];
  warnings: string[];
  droppedCitations: string[];
  error: SuggestionError | null;
  startedAt: string | null;
  finishedAt: string | null;
  appliedHunks: number[] | null;
  /** The range in `originalMarkdown` (code points), `null` for the whole section. */
  anchor: { start: number; end: number } | null;
  cancelledBy: string | null;
}

export function emptyParams(): SuggestionParams {
  return {
    moreProofs: false,
    moreExamples: false,
    moreRigorous: false,
    shorter: false,
    longer: false,
    citeSources: false,
    fixIssueIds: [],
    addressCommentIds: [],
  };
}

function parseParams(value: unknown): SuggestionParams {
  const raw = record(value);
  const flag = (key: string) => raw[key] === true;
  return {
    moreProofs: flag('moreProofs'),
    moreExamples: flag('moreExamples'),
    moreRigorous: flag('moreRigorous'),
    shorter: flag('shorter'),
    longer: flag('longer'),
    citeSources: flag('citeSources'),
    fixIssueIds: strings(raw['fixIssueIds']),
    addressCommentIds: strings(raw['addressCommentIds']),
  };
}

function parseRange(value: unknown): { start: number; end: number } | null {
  const raw = record(value);
  return typeof raw['start'] === 'number' && typeof raw['end'] === 'number'
    ? { start: raw['start'], end: raw['end'] }
    : null;
}

function parseHunks(value: unknown): Hunk[] {
  if (!Array.isArray(value)) return [];
  const hunks: Hunk[] = [];
  for (const item of value) {
    const raw = record(item);
    const start = raw['start'];
    const end = raw['end'];
    if (typeof start !== 'number' || typeof end !== 'number' || end < start) continue;
    hunks.push({ start, end, removed: str(raw['removed']), added: str(raw['added']) });
  }
  return hunks;
}

export function suggestionPayload(comment: Pick<Comment, 'payload'>): SuggestionPayload {
  const payload = record(comment.payload);
  const error = record(payload['error']);
  const original = payload['originalMarkdown'];
  const replacement = payload['replacementMarkdown'];
  const applied = payload['appliedHunks'];
  return {
    verb: payload['verb'] === 'rewrite' ? 'rewrite' : 'revise',
    scope: payload['scope'] === 'range' ? 'range' : 'section',
    instruction: str(payload['instruction']),
    params: parseParams(payload['params']),
    threadId: typeof payload['threadId'] === 'string' ? payload['threadId'] : null,
    baseContentHash:
      typeof payload['baseContentHash'] === 'string' ? payload['baseContentHash'] : null,
    originalMarkdown: typeof original === 'string' ? original : null,
    replacementMarkdown: typeof replacement === 'string' ? replacement : null,
    hunks: parseHunks(payload['hunks']),
    summary: str(payload['summary']),
    changesMade: strings(payload['changesMade']),
    warnings: strings(payload['warnings']),
    droppedCitations: strings(payload['droppedCitations']),
    error:
      typeof error['code'] === 'string'
        ? { code: error['code'], message: str(error['message']) }
        : null,
    startedAt: typeof payload['startedAt'] === 'string' ? payload['startedAt'] : null,
    finishedAt: typeof payload['finishedAt'] === 'string' ? payload['finishedAt'] : null,
    anchor: parseRange(payload['anchor']),
    cancelledBy: typeof payload['cancelledBy'] === 'string' ? payload['cancelledBy'] : null,
    appliedHunks: Array.isArray(applied)
      ? applied.filter((index): index is number => typeof index === 'number')
      : null,
  };
}
