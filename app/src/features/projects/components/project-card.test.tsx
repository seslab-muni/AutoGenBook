import userEvent from '@testing-library/user-event';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderRouterApp } from '@/test/router-test-utils';

describe('ProjectCard actions', () => {
  it("shows the last run's cost for a project that has completed one", async () => {
    renderRouterApp('/');

    const card = (
      await screen.findByRole('heading', { name: /Distributed Consensus & Quantum Fault/i })
    ).closest('[role="button"]') as HTMLElement;
    // Seeded in `mocks/fixtures.ts`'s `seedProject` for a project with `hasCompletedRun: true`.
    expect(await within(card).findByText('$6.42')).toBeInTheDocument();
  });

  it('shows no cost for a project with no completed run', async () => {
    renderRouterApp('/');

    const card = (
      await screen.findByRole('heading', { name: /Deep Reinforcement Learning & Multi-Agent/i })
    ).closest('[role="button"]') as HTMLElement;
    expect(within(card).queryByText(/^\$/)).not.toBeInTheDocument();
  });

  it('duplicates a project and navigates to the copy', async () => {
    const user = userEvent.setup();
    renderRouterApp('/');

    const card = (
      await screen.findByRole('heading', { name: /Distributed Consensus & Quantum Fault/i })
    ).closest('[role="button"]') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: /project actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /duplicate/i }));

    expect(
      await screen.findByRole('heading', {
        name: /Distributed Consensus & Quantum Fault Tolerance \(Copy\)/i,
        level: 1,
      }),
    ).toBeInTheDocument();
  });

  it('deletes a project after confirmation', async () => {
    const user = userEvent.setup();
    renderRouterApp('/');

    const card = (
      await screen.findByRole('heading', { name: /Deep Reinforcement Learning & Multi-Agent/i })
    ).closest('[role="button"]') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: /project actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }));
    await user.click(await screen.findByRole('button', { name: /delete project/i }));

    expect(
      screen.queryByRole('heading', { name: /Deep Reinforcement Learning & Multi-Agent/i }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: /Distributed Consensus & Quantum Fault/i }),
    ).toBeInTheDocument();
  });
});
