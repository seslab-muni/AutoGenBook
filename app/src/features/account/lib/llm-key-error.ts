import { toast } from 'sonner';

import { ApiError } from '@/api/client';
import { useUiStore } from '@/stores/ui-store';

/** The API's problem `code` for a run refused because `LLM_KEY_POLICY=required` and the user has no key. */
export const LLM_KEY_REQUIRED_CODE = 'llm_key_required';

export function isLlmKeyRequiredError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.problem?.code === LLM_KEY_REQUIRED_CODE;
}

/**
 * Shared by every run-queuing action (start run, regenerate, export, retry): when `error` is the
 * `llm_key_required` 409, shows a toast with an "Account settings" shortcut and returns `true` so
 * the caller skips its own generic handling; otherwise returns `false`.
 */
export function handleLlmKeyRequired(error: unknown): boolean {
  if (!isLlmKeyRequiredError(error)) return false;
  toast.error(error.problem?.detail ?? 'An LLM API key is required to start runs', {
    action: {
      label: 'Account settings',
      onClick: () => useUiStore.getState().openModal('account'),
    },
  });
  return true;
}
