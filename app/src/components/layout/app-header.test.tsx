import userEvent from '@testing-library/user-event';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderRouterApp } from '@/test/router-test-utils';

describe('AppHeader project switcher', () => {
  it('navigates to the selected project', async () => {
    const user = userEvent.setup();
    renderRouterApp('/p/book-consensus-quantum-2026');

    await screen.findByRole('heading', {
      name: /Distributed Consensus & Quantum Fault Tolerance/i,
    });

    await user.click(await screen.findByRole('button', { name: /switch project/i }));
    await user.click(
      await screen.findByRole('menuitem', {
        name: /Deep Reinforcement Learning & Multi-Agent Planning/i,
      }),
    );

    expect(
      await screen.findByRole('heading', {
        name: /Deep Reinforcement Learning & Multi-Agent Planning/i,
      }),
    ).toBeInTheDocument();
  });

  it('opens the sources modal state without navigating', async () => {
    const user = userEvent.setup();
    renderRouterApp('/p/book-consensus-quantum-2026');

    await screen.findByRole('heading', {
      name: /Distributed Consensus & Quantum Fault Tolerance/i,
    });
    await user.click(screen.getByRole('button', { name: /^sources/i }));

    const { useUiStore } = await import('@/stores/ui-store');
    expect(useUiStore.getState().activeModal).toBe('sources');
  });
});
