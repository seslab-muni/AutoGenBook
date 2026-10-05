import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client';
import { useUiStore } from '@/stores/ui-store';

import { handleLlmKeyRequired } from './llm-key-error';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

function apiError(status: number, code?: string): ApiError {
  return new ApiError({
    status,
    url: '/x',
    problem: {
      type: 'about:blank',
      title: 'Conflict',
      status,
      instance: '/x',
      detail: 'set your key',
      ...(code ? { code } : {}),
    },
  });
}

beforeEach(() => {
  vi.mocked(toast.error).mockReset();
  useUiStore.setState({ activeModal: null });
});

describe('handleLlmKeyRequired', () => {
  it('handles llm_key_required with an Account settings shortcut', () => {
    expect(handleLlmKeyRequired(apiError(409, 'llm_key_required'))).toBe(true);
    const [message, options] = vi.mocked(toast.error).mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(message).toBe('set your key');
    expect(options.action.label).toBe('Account settings');
    options.action.onClick();
    expect(useUiStore.getState().activeModal).toBe('account');
  });

  it('ignores other errors', () => {
    expect(handleLlmKeyRequired(apiError(409))).toBe(false);
    expect(handleLlmKeyRequired(new Error('boom'))).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
