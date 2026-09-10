import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeRunEvents } from '@/api/sse';
import { db } from '@/mocks/db';
import { useUiStore } from '@/stores/ui-store';
import { renderRouterApp } from '@/test/router-test-utils';
import { DEFAULT_RUN_OPTIONS } from '@/test/run-options-fixture';

// This exercises `StartRunDialog` mounted inside the real project route (`renderRouterApp`,
// needed for `useNavigate`), which also mounts `useProjectRuns`'s SSE subscription once a run
// starts running — mocked here for the same reason as `use-run-stream.test.ts`.
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

  it('queues a second full run behind an already-running one instead of 409ing (issue #134)', async () => {
    db.runs.set('run-already-running', {
      id: 'run-already-running',
      projectId: PROJECT_ID,
      kind: 'full',
      status: 'running',
      options: DEFAULT_RUN_OPTIONS,
      baseRunId: null,
      targetNodeId: null,
      exitCode: null,
      error: null,
      totalTokens: null,
      totalCostUsd: null,
      resumable: true,
      retryable: false,
      queuedAt: '2026-09-06T00:00:00Z',
      startedAt: '2026-09-06T00:00:01Z',
      finishedAt: null,
      startedById: null,
      startedByName: null,
    });

    const user = userEvent.setup();
    renderRouterApp(`/p/${PROJECT_ID}`);
    await screen.findByRole('heading', { name: /Distributed Consensus/i });

    useUiStore.setState({ activeModal: 'start-run' });
    await screen.findByRole('heading', { name: 'Start a run' });
    await user.click(screen.getByRole('button', { name: 'Start run' }));

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Start a run' })).not.toBeInTheDocument(),
    );
    expect(await screen.findByText(/queued, position 1 of 1/i)).toBeInTheDocument();
    // Landed on the new (queued) run's own detail page rather than being blocked.
    expect(await screen.findByText('Full run')).toBeInTheDocument();
  });

  it("shows a 409 toast once the project's run queue is full", async () => {
    // Occupies the project's single running slot for the whole test, so every run this test
    // creates stays `queued` deterministically — without this, whichever run the mock's own
    // `driveFakeRun` claims off the queue ~300ms in would stop counting against the cap,
    // making a real-time-sensitive test of "exactly 5 queued" flaky.
    db.runs.set('run-already-running', {
      id: 'run-already-running',
      projectId: PROJECT_ID,
      kind: 'full',
      status: 'running',
      options: DEFAULT_RUN_OPTIONS,
      baseRunId: null,
      targetNodeId: null,
      exitCode: null,
      error: null,
      totalTokens: null,
      totalCostUsd: null,
      resumable: true,
      retryable: false,
      queuedAt: '2026-09-06T00:00:00Z',
      startedAt: '2026-09-06T00:00:01Z',
      finishedAt: null,
      startedById: null,
      startedByName: null,
    });

    const user = userEvent.setup();
    renderRouterApp(`/p/${PROJECT_ID}`);
    await screen.findByRole('heading', { name: /Distributed Consensus/i });

    // `MAX_QUEUED_RUNS_PER_PROJECT` (5, `handlers.ts`) queued runs are all admitted.
    for (let i = 0; i < 5; i += 1) {
      useUiStore.setState({ activeModal: 'start-run' });
      await screen.findByRole('heading', { name: 'Start a run' });
      await user.click(screen.getByRole('button', { name: 'Start run' }));
      await waitFor(() =>
        expect(screen.queryByRole('heading', { name: 'Start a run' })).not.toBeInTheDocument(),
      );
    }

    // The 6th is refused: the queue is full.
    useUiStore.setState({ activeModal: 'start-run' });
    await screen.findByRole('heading', { name: 'Start a run' });
    await user.click(screen.getByRole('button', { name: 'Start run' }));

    const matches = await screen.findAllByText(/run queue is full/i);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("defaults the model field to the project's own model", async () => {
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
