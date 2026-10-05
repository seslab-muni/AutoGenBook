import userEvent from '@testing-library/user-event';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeRunEvents } from '@/api/sse';
import { db } from '@/mocks/db';
import { useUiStore } from '@/stores/ui-store';
import { renderRouterApp } from '@/test/router-test-utils';

// The project layout (which hosts `AccountDialog`) mounts the run SSE subscription - mocked as in
// `app-header.test.tsx`.
vi.mock('@/api/sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sse')>();
  return { ...actual, subscribeRunEvents: vi.fn() };
});

const mockedSubscribe = vi.mocked(subscribeRunEvents);
const PROJECT_ID = 'book-consensus-quantum-2026';

beforeEach(() => {
  mockedSubscribe.mockReset();
  mockedSubscribe.mockReturnValue(vi.fn());
});

afterEach(() => {
  useUiStore.setState({ activeModal: null });
});

async function openAccountDialog() {
  renderRouterApp(`/p/${PROJECT_ID}`);
  await screen.findByRole('heading', { name: /Distributed Consensus/i });
  useUiStore.setState({ activeModal: 'account' });
  return screen.findByRole('dialog', { name: 'Account' });
}

describe('AccountDialog', () => {
  it('is opened from the header account menu', async () => {
    const user = userEvent.setup();
    renderRouterApp(`/p/${PROJECT_ID}`);
    await screen.findByRole('heading', { name: /Distributed Consensus/i });

    await user.click(await screen.findByRole('button', { name: 'Account menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Account settings' }));

    expect(await screen.findByRole('dialog', { name: 'Account' })).toBeInTheDocument();
  });

  it('shows "No key set" and saves a key, then shows only its last four characters', async () => {
    const user = userEvent.setup();
    const dialog = await openAccountDialog();
    expect(await within(dialog).findByTestId('llm-key-status')).toHaveTextContent('No key set');

    const input = within(dialog).getByLabelText('API key');
    expect(input).toHaveAttribute('type', 'password');
    // Password managers must not treat this as the login password.
    expect(input).toHaveAttribute('autocomplete', 'new-password');
    expect(input).toHaveAttribute('data-1p-ignore');
    expect(input).toHaveAttribute('data-lpignore', 'true');
    expect(input).toHaveAccessibleDescription(/stored encrypted/);
    const save = within(dialog).getByRole('button', { name: 'Save key' });
    expect(save).toBeDisabled();

    await user.type(input, 'sk-or-v1-secretvalue9876');
    await user.click(save);

    await waitFor(() =>
      expect(within(dialog).getByTestId('llm-key-status')).toHaveTextContent(
        'Key set, ends in ••••9876',
      ),
    );
    expect(dialog).not.toHaveTextContent('secretvalue');
    // The typed secret is cleared once submitted.
    expect(within(dialog).getByLabelText('Replace key')).toHaveValue('');
    expect(db.llmKey?.last4).toBe('9876');
  });

  it('removes a stored key', async () => {
    db.llmKey = { last4: '1234', updatedAt: '2026-10-01T00:00:00Z' };
    const user = userEvent.setup();
    const dialog = await openAccountDialog();
    expect(await within(dialog).findByTestId('llm-key-status')).toHaveTextContent(
      'ends in ••••1234',
    );

    await user.click(within(dialog).getByRole('button', { name: 'Remove key' }));
    // Destructive: needs a second, explicit confirmation.
    expect(db.llmKey).not.toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Confirm remove' }));

    await waitFor(() =>
      expect(within(dialog).getByTestId('llm-key-status')).toHaveTextContent('No key set'),
    );
    expect(db.llmKey).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Remove key' })).toBeNull();
  });

  it('explains and disables the input when the feature is not configurable', async () => {
    db.llmKeyConfigurable = false;
    const dialog = await openAccountDialog();

    expect(await within(dialog).findByRole('note')).toHaveTextContent('not enabled');
    expect(within(dialog).getByLabelText('API key')).toBeDisabled();
    expect(within(dialog).getByLabelText('API key')).toHaveAccessibleDescription(/not enabled/);
    expect(within(dialog).getByRole('button', { name: 'Save key' })).toBeDisabled();
  });

  it('cancelling the remove confirmation keeps the key', async () => {
    db.llmKey = { last4: '1234', updatedAt: '2026-10-01T00:00:00Z' };
    const user = userEvent.setup();
    const dialog = await openAccountDialog();
    await within(dialog).findByTestId('llm-key-status');

    await user.click(within(dialog).getByRole('button', { name: 'Remove key' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(db.llmKey).not.toBeNull();
    expect(within(dialog).getByTestId('llm-key-status')).toHaveTextContent('ends in ••••1234');
  });

  it('shows the server validation message for a rejected key', async () => {
    const user = userEvent.setup();
    const dialog = await openAccountDialog();
    await within(dialog).findByTestId('llm-key-status');

    await user.type(within(dialog).getByLabelText('API key'), 'k'.repeat(600));
    await user.click(within(dialog).getByRole('button', { name: 'Save key' }));

    // No client-side maxLength: the 422 from the API surfaces instead (here: the MSW mock's
    // own length rule, mirroring `AuthService.set_llm_key`).
    expect(await screen.findByText(/at most 512 characters/)).toBeInTheDocument();
    expect(db.llmKey).toBeNull();

    // Editing the input clears the stale error.
    await user.type(within(dialog).getByLabelText('API key'), 'x');
    expect(screen.queryByText(/at most 512 characters/)).not.toBeInTheDocument();
  });
});
