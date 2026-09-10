import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeRunEvents } from '@/api/sse';
import { MOCK_USER } from '@/mocks/fixtures';
import * as session from '@/auth/session';
import { useUiStore } from '@/stores/ui-store';
import { renderRouterApp } from '@/test/router-test-utils';

// The project layout mounts `useProjectRuns` (hence `useRunStream`) unconditionally now that
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
  it('stays "Run" while a run is only queued, then shows "Generating…" once it starts (issue #134)', async () => {
    const user = userEvent.setup();
    renderRouterApp('/p/book-consensus-quantum-2026');
    await screen.findByRole('heading', { name: /Distributed Consensus/i });

    await user.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findByRole('heading', { name: 'Start a run' });
    await user.click(screen.getByRole('button', { name: 'Start run' }));

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Start a run' })).not.toBeInTheDocument(),
    );
    // Nothing is running yet (the mock worker claims it off the queue ~300ms in) — the header
    // still shows a plain, clickable "Run" rather than treating a merely-queued run as busy.
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument();

    // The generous timeout here is real-timer CI-jitter headroom (see `export-dialog.test.tsx`'s
    // note on the same class of test), not the nominal time this takes.
    expect(
      await screen.findByRole('button', { name: /Generating…/i }, { timeout: 10000 }),
    ).toBeInTheDocument();
  }, 15000);

  it('queues a second run from the "Generating…" menu and reflects it in the queued count', async () => {
    const user = userEvent.setup();
    renderRouterApp('/p/book-consensus-quantum-2026');
    await screen.findByRole('heading', { name: /Distributed Consensus/i });

    await user.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findByRole('heading', { name: 'Start a run' });
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Start a run' })).not.toBeInTheDocument(),
    );
    await screen.findByRole('button', { name: /Generating…/i }, { timeout: 10000 });

    await user.click(screen.getByRole('button', { name: /Generating…/i }));
    await user.click(screen.getByRole('menuitem', { name: /queue another run/i }));
    await screen.findByRole('heading', { name: 'Start a run' });
    await user.click(screen.getByRole('button', { name: 'Start run' }));

    expect(
      await screen.findByRole('button', { name: /Generating…\s*·\s*1 queued/i }),
    ).toBeInTheDocument();

    // "View queue" opens the same run-history panel the header's own history icon does.
    await user.click(screen.getByRole('button', { name: /Generating…/i }));
    await user.click(screen.getByRole('menuitem', { name: /view queue/i }));
    expect(await screen.findByRole('dialog', { name: /run history/i })).toBeInTheDocument();
  }, 15000);
});

describe('AppHeader project owner', () => {
  it('shows "Created by <name>" for a project with an owner', async () => {
    renderRouterApp('/p/book-consensus-quantum-2026');

    expect(
      await screen.findByText(new RegExp(`Created by ${MOCK_USER.displayName}`)),
    ).toBeInTheDocument();
  });

  it('shows "Created by —" for a legacy project with no owner', async () => {
    // Seeded as `owned: false` in `mocks/fixtures.ts`.
    renderRouterApp('/p/book-reinforcement-learning');

    expect(await screen.findByText(/Created by —/)).toBeInTheDocument();
  });
});

describe('AppHeader user menu', () => {
  it('shows the signed-in user and calls signOut when "Sign out" is selected', async () => {
    const signOutSpy = vi.spyOn(session, 'signOut').mockImplementation(() => {});
    const user = userEvent.setup();
    renderRouterApp('/p/book-consensus-quantum-2026');
    await screen.findByRole('heading', { name: /Distributed Consensus/i });

    await user.click(await screen.findByRole('button', { name: /account menu/i }));
    expect(await screen.findByText(MOCK_USER.displayName)).toBeInTheDocument();
    expect(screen.getByText(MOCK_USER.email)).toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: /sign out/i }));
    expect(signOutSpy).toHaveBeenCalledTimes(1);

    signOutSpy.mockRestore();
  });
});
