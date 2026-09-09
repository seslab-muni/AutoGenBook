import userEvent from '@testing-library/user-event';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useUiStore } from '@/stores/ui-store';
import { renderRouterApp } from '@/test/router-test-utils';

afterEach(() => {
  useUiStore.setState({ activeModal: null });
});

describe('ProjectsHub', () => {
  it('lists the seeded projects and filters them by search', async () => {
    const user = userEvent.setup();
    renderRouterApp('/');

    expect(
      await screen.findByRole('heading', { name: /Distributed Consensus & Quantum Fault/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Deep Reinforcement Learning & Multi-Agent Planning/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/3 projects/i)).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: /search projects/i }), 'quantum');

    expect(
      screen.getByRole('heading', { name: /Distributed Consensus & Quantum Fault/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', {
        name: /Deep Reinforcement Learning & Multi-Agent Planning/i,
      }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/1 project$/i)).toBeInTheDocument();
  });

  it('shows an empty state when the search has no matches', async () => {
    const user = userEvent.setup();
    renderRouterApp('/');

    await screen.findByRole('heading', { name: /Distributed Consensus & Quantum Fault/i });
    await user.type(screen.getByRole('textbox', { name: /search projects/i }), 'nonexistent-xyz');

    expect(await screen.findByText(/no matching projects/i)).toBeInTheDocument();
  });

  it('opens the new-project modal from the hub header', async () => {
    const user = userEvent.setup();
    renderRouterApp('/');

    await screen.findByRole('heading', { name: /Distributed Consensus & Quantum Fault/i });
    await user.click(screen.getByRole('button', { name: /new project/i }));

    expect(useUiStore.getState().activeModal).toBe('new-project');
    expect(await screen.findByRole('dialog', { name: /new project/i })).toBeInTheDocument();
  });

  it('opens a project when its card is clicked', async () => {
    const user = userEvent.setup();
    renderRouterApp('/');

    await screen.findByRole('heading', { name: /Distributed Consensus & Quantum Fault/i });
    // The card's click target is a full-card overlay button (see `project-card.tsx`), not the
    // heading itself - real browsers hit-test to it regardless of where on the card you click,
    // but jsdom's `user.click` dispatches directly on its target and bubbles through actual DOM
    // ancestors, so the test has to target that button explicitly rather than the heading text.
    await user.click(
      screen.getByRole('button', { name: /Open Distributed Consensus & Quantum Fault/i }),
    );

    expect(
      await screen.findByRole('heading', {
        name: /Distributed Consensus & Quantum Fault Tolerance/i,
        level: 1,
      }),
    ).toBeInTheDocument();
  });
});
