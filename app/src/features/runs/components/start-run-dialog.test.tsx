import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeRunEvents } from '@/api/sse';
import { useUiStore } from '@/stores/ui-store';
import { renderRouterApp } from '@/test/router-test-utils';

// This exercises `StartRunDialog` mounted inside the real project route (`renderRouterApp`,
// needed for `useNavigate`), which also mounts `useActiveRun`'s SSE subscription once a run
// becomes active — mocked here for the same reason as `use-run-stream.test.ts`.
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

describe('StartRunDialog', () => {
  it('starting a run navigates to its detail page', async () => {
    const user = userEvent.setup();
    renderRouterApp(`/p/${PROJECT_ID}`);
    await screen.findByRole('heading', { name: /Distributed Consensus/i });

    useUiStore.setState({ activeModal: 'start-run' });
    await screen.findByRole('heading', { name: 'Start a run' });

    await user.click(screen.getByRole('button', { name: 'Start run' }));

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Start a run' })).not.toBeInTheDocument(),
    );
    // Landed on the new run's detail page.
    expect(await screen.findByText('Full run')).toBeInTheDocument();
  });

  it('shows a 409 toast when a run is already active', async () => {
    const user = userEvent.setup();
    renderRouterApp(`/p/${PROJECT_ID}`);
    await screen.findByRole('heading', { name: /Distributed Consensus/i });

    useUiStore.setState({ activeModal: 'start-run' });
    await screen.findByRole('heading', { name: 'Start a run' });
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Start a run' })).not.toBeInTheDocument(),
    );

    // Try to start a second one for the same project.
    useUiStore.setState({ activeModal: 'start-run' });
    await screen.findByRole('heading', { name: 'Start a run' });
    await user.click(screen.getByRole('button', { name: 'Start run' }));

    const matches = await screen.findAllByText('Project already has a queued or running run');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('defaults the model field to the project\'s own model', async () => {
    renderRouterApp(`/p/${PROJECT_ID}`);
    await screen.findByRole('heading', { name: /Distributed Consensus/i });

    useUiStore.setState({ activeModal: 'start-run' });
    await screen.findByRole('heading', { name: 'Start a run' });

    expect(screen.getByLabelText(/llm model/i)).toHaveTextContent('openai/gpt-5-mini');
  });

  it('starting a run with an overridden model shows it on the run detail page', async () => {
    const user = userEvent.setup();
    renderRouterApp(`/p/${PROJECT_ID}`);
    await screen.findByRole('heading', { name: /Distributed Consensus/i });

    useUiStore.setState({ activeModal: 'start-run' });
    await screen.findByRole('heading', { name: 'Start a run' });

    await user.click(screen.getByLabelText(/llm model/i));
    const modelInput = await screen.findByPlaceholderText('e.g. openai/gpt-5-mini');
    await user.clear(modelInput);
    await user.type(modelInput, 'anthropic/claude-3.5-sonnet');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Start run' }));

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Start a run' })).not.toBeInTheDocument(),
    );
    expect(await screen.findByText('anthropic/claude-3.5-sonnet')).toBeInTheDocument();
  });
});
