import userEvent from '@testing-library/user-event';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useUiStore } from '@/stores/ui-store';
import { renderRouterApp } from '@/test/router-test-utils';

afterEach(() => {
  useUiStore.setState({ activeModal: null });
});

describe('ProjectSettingsDialog', () => {
  it('edits and saves project metadata', async () => {
    const user = userEvent.setup();
    renderRouterApp('/p/book-consensus-quantum-2026');

    await screen.findByRole('heading', { name: /Distributed Consensus & Quantum Fault/i });
    await user.click(screen.getByRole('button', { name: /settings/i }));

    const titleInput = await screen.findByLabelText(/^title$/i);
    expect(titleInput).toHaveValue('Distributed Consensus & Quantum Fault Tolerance');

    await user.clear(titleInput);
    await user.type(titleInput, 'Consensus, Revised');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(
      await screen.findByRole('heading', { name: /^Consensus, Revised$/i, level: 1 }),
    ).toBeInTheDocument();
  });

  it('deletes the project and returns to the hub', async () => {
    const user = userEvent.setup();
    renderRouterApp('/p/book-consensus-quantum-2026');

    await screen.findByRole('heading', { name: /Distributed Consensus & Quantum Fault/i });
    await user.click(screen.getByRole('button', { name: /settings/i }));
    await screen.findByLabelText(/^title$/i);

    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    await user.click(await screen.findByRole('button', { name: /delete project/i }));

    expect(await screen.findByText(/AutoGenBook Studio/i, { selector: 'h1' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /Distributed Consensus & Quantum Fault/i }),
    ).not.toBeInTheDocument();
  });
});
