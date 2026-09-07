import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeRunEvents } from '@/api/sse';
import { useUiStore } from '@/stores/ui-store';
import { renderRouterApp } from '@/test/router-test-utils';

// The project layout mounts `useActiveRun` (hence `useRunStream`) unconditionally now that
// issue #21 wires it up - mocked here for the reasons in `use-run-stream.test.ts`.
vi.mock('@/api/sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sse')>();
  return { ...actual, subscribeRunEvents: vi.fn() };
});

const mockedSubscribe = vi.mocked(subscribeRunEvents);

beforeEach(() => {
  mockedSubscribe.mockReset();
  mockedSubscribe.mockReturnValue(vi.fn());
});

afterEach(() => {
  useUiStore.setState({ activeModal: null });
});

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

  it('opens the start-run modal without navigating when idle', async () => {
    const user = userEvent.setup();
    renderRouterApp('/p/book-consensus-quantum-2026');

    await screen.findByRole('heading', { name: /Distributed Consensus/i });
    await user.click(screen.getByRole('button', { name: 'Run' }));

    const { useUiStore } = await import('@/stores/ui-store');
    expect(useUiStore.getState().activeModal).toBe('start-run');
  });
});

describe('AppHeader run state machine', () => {
  it('shows Running… with a cancel action once a run is queued, and Run again once cancelled', async () => {
    const user = userEvent.setup();
    renderRouterApp('/p/book-consensus-quantum-2026');
    await screen.findByRole('heading', { name: /Distributed Consensus/i });

    await user.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findByRole('heading', { name: 'Start a run' });
    await user.click(screen.getByRole('button', { name: 'Start run' }));

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Start a run' })).not.toBeInTheDocument(),
    );
    expect(await screen.findByRole('button', { name: /Queued…/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Queued…/i }));
    await user.click(screen.getByRole('menuitem', { name: /cancel run/i }));
    await user.click(screen.getByRole('button', { name: 'Cancel run' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument());
  });
});
