import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderRouterApp } from '@/test/router-test-utils';

describe('root route', () => {
  it('renders the projects hub with seeded projects', async () => {
    renderRouterApp('/');

    expect(
      await screen.findByRole('heading', { name: /Distributed Consensus & Quantum Fault/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Deep Reinforcement Learning & Multi-Agent Planning/i }),
    ).toBeInTheDocument();
  });

  it('renders the studio shell for a known project', async () => {
    renderRouterApp('/p/book-consensus-quantum-2026');

    expect(
      await screen.findByRole('heading', {
        name: /Distributed Consensus & Quantum Fault Tolerance/i,
      }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/Foundations of Classical Asynchronous Consensus/i),
    ).toBeInTheDocument();
  });

  it('renders the not-found view for an unknown project id', async () => {
    renderRouterApp('/p/does-not-exist');

    expect(
      await screen.findByText(/This project doesn't exist or was removed/i),
    ).toBeInTheDocument();
  });
});
