import { ApiError } from '@/api/client';
import { problemMessage } from './errors';

/** A refusal or failure, in words for the person who asked: shown inline, never as a bare status code. */
export interface CopilotFailure {
  message: string;
  /** The API's `code`, when it sent one (`llm_key_required` offers a shortcut to the account dialog). */
  code: string | null;
}

/** Why a revision could not start: the problem `code`s of `POST .../revisions`. */
const START_MESSAGES: Record<string, string> = {
  section_empty:
    'This section is empty, so there is nothing to revise. Write something first, or start a run to draft it.',
  node_generating: 'A run is generating this section right now. Try again when it has finished.',
  anchor_orphaned: 'The text you selected has changed or is gone. Select it again and ask again.',
  revision_in_progress:
    'A revision of this section is already running. Wait for it to finish or cancel it.',
  llm_key_required:
    'An LLM API key is required to use the copilot. Add yours in your account settings.',
  llm_not_configured: 'No LLM key is configured for this deployment, so the copilot cannot run.',
  too_many_revisions:
    'You already have several revisions running. Wait for one to finish or cancel it.',
  section_too_large:
    'This section is too long to revise all at once. Select a passage and revise that instead.',
};

/** Why a started revision ended: `payload.error.code` of a failed suggestion. */
const FAILURE_MESSAGES: Record<string, string> = {
  llm_auth: 'The language model provider rejected the API key. Check your key in account settings.',
  llm_rate_limited: 'The language model provider is rate limiting requests. Try again in a minute.',
  llm_timeout:
    'The language model took too long to answer. Try again, or select a smaller passage.',
  llm_error: 'The language model provider returned an error. Try again.',
  llm_config: 'The language model is not configured correctly for this project.',
  unusable_output:
    'The model’s answer could not be read. Try again, perhaps with a clearer instruction.',
  anchor_orphaned: 'The text this was about changed before the revision could start.',
  revision_failed: 'The revision could not be applied.',
  invalid_request: 'The request was not valid.',
  timeout: 'The revision took too long and was stopped.',
  interrupted: 'The revision was interrupted (the server restarted). Try again.',
  internal: 'Something went wrong on the server. Try again.',
};

/** Why an accept was refused. */
const ACCEPT_MESSAGES: Record<string, string> = {
  stale:
    'The text this suggestion was made for has changed, so it can no longer be applied cleanly. Try again to get a fresh suggestion.',
  content_conflict:
    'The section changed since you last saw it. Your view has been refreshed; review it and accept again if the suggestion still fits.',
  not_pending: 'This suggestion was already accepted, rejected or withdrawn.',
  node_generating: 'A run is generating this section right now. Accept when it has finished.',
  run_active: 'A full run is queued or running and would overwrite this section. Accept after it.',
  invalid_suggestion: 'This suggestion can no longer be applied.',
};

function codeOf(error: unknown): string | null {
  return error instanceof ApiError ? (error.problem?.code ?? null) : null;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** What a Rewrite (the regenerate endpoint) can refuse with: it sends free text, so it is matched, not coded. */
const REWRITE_PATTERNS: [RegExp, string][] = [
  [
    /no successful prior run|work directory no longer exists/i,
    'There is no finished run to rewrite from. Start a full run first.',
  ],
  [
    /already has a regenerate queued|already .*queued or running/i,
    'This section already has a rewrite queued or running.',
  ],
  [/content-locked|locked/i, 'This section’s content is locked. Unlock it to rewrite it.'],
  [
    /full run is queued or running/i,
    'A full run is queued or running for this project. Wait for it to finish or cancel it.',
  ],
  [
    /queue is full/i,
    'The run queue for this project is full. Try again when one run has finished.',
  ],
  [/container|leaf/i, 'Only leaf sections can be rewritten. Select a section below this one.'],
];

export function describeStartError(
  error: unknown,
  verb: 'revise' | 'rewrite' = 'revise',
): CopilotFailure {
  const code = codeOf(error);
  const known = code ? START_MESSAGES[code] : undefined;
  if (known) return { message: known, code };
  if (
    verb === 'rewrite' &&
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500
  ) {
    const text = `${error.problem?.title ?? ''} ${error.problem?.detail ?? ''}`;
    const matched = REWRITE_PATTERNS.find(([pattern]) => pattern.test(text));
    return {
      message: matched ? matched[1] : 'The rewrite could not be started. Try again later.',
      code,
    };
  }
  // Never an id the person cannot use.
  return { message: problemMessage(error).replace(UUID, 'this section'), code };
}

/** The text for a failed suggestion card; the server's own wording backs up a code we do not know. */
export function describeSuggestionFailure(code: string | null, message: string): string {
  const known = code ? FAILURE_MESSAGES[code] : undefined;
  if (code === 'revision_failed' && message) return `${known} ${message}`;
  return known ?? (message || 'The revision failed.');
}

export function describeAcceptError(error: unknown): CopilotFailure {
  const code = codeOf(error);
  const known = code ? ACCEPT_MESSAGES[code] : undefined;
  return { message: known ?? problemMessage(error), code };
}

export function isContentConflict(error: unknown): boolean {
  return codeOf(error) === 'content_conflict';
}
