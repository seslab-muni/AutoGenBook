import userEvent from '@testing-library/user-event';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useUiStore } from '@/stores/ui-store';
import { renderRouterApp } from '@/test/router-test-utils';

afterEach(() => {
  useUiStore.setState({ activeModal: null });
});

describe('NewProjectDialog', () => {
  it('is reachable from the app header and creates a project', async () => {
    const user = userEvent.setup();
    renderRouterApp('/p/book-consensus-quantum-2026');

    await screen.findByRole('heading', { name: /Distributed Consensus & Quantum Fault/i });
    await user.click(screen.getByRole('button', { name: /new project/i }));

    const dialog = await screen.findByRole('dialog', { name: /new project/i });
    const createButton = screen.getByRole('button', { name: /create project/i });
    expect(createButton).toBeDisabled();

    await user.type(screen.getByLabelText(/^title$/i), 'Applied Category Theory');
    await user.type(screen.getByLabelText(/^subtitle$/i), 'A Compositional Approach');
    await user.type(screen.getByLabelText(/^topic$/i), 'Monoidal categories and string diagrams');
    await user.type(screen.getByLabelText(/^authors$/i), 'Ada Lovelace');

    expect(createButton).toBeEnabled();
    await user.click(createButton);

    expect(
      await screen.findByRole('heading', { name: /Applied Category Theory/i, level: 1 }),
    ).toBeInTheDocument();
    expect(dialog).not.toBeInTheDocument();
  });
});
