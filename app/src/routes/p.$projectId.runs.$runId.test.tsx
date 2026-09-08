import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeRunEvents } from '@/api/sse';
import { db } from '@/mocks/db';
import { MOCK_USER } from '@/mocks/fixtures';
import { renderRouterApp } from '@/test/router-test-utils';
import { DEFAULT_RUN_OPTIONS } from '@/test/run-options-fixture';

// See `use-run-stream.test.ts` for why SSE is mocked wherever `useRunStream` mounts (this route
// always mounts one, for whichever run is being viewed).
vi.mock('@/api/sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sse')>();
  return { ...actual, subscribeRunEvents: vi.fn() };
});

const mockedSubscribe = vi.mocked(subscribeRunEvents);

const PROJECT_ID = 'book-consensus-quantum-2026';
const RUN_ID = 'book-consensus-quantum-2026-run-1';

beforeEach(() => {
  mockedSubscribe.mockReset();
  mockedSubscribe.mockReturnValue(vi.fn());
});

describe('run detail page', () => {
  it('renders the seeded successful run: kind, status, resumable badge, event log, artifacts', async () => {
    renderRouterApp(`/p/${PROJECT_ID}/runs/${RUN_ID}`);

    expect(await screen.findByRole('heading', { name: 'Full run' })).toBeInTheDocument();
    expect(screen.getByText('Succeeded')).toBeInTheDocument();
    expect(screen.getByText('Resumable')).toBeInTheDocument();
    expect(await screen.findByText('Run succeeded.')).toBeInTheDocument();
    expect(await screen.findByText(/book\.md|run_meta\.json/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /download/i }).length).toBeGreaterThan(0);
    // A finished run has no Cancel action.
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
    expect(screen.getByText(new RegExp(`Started by ${MOCK_USER.displayName}`))).toBeInTheDocument();
  });

  it('shows "—" for Started by when the run has no attributed user', async () => {
    const runId = 'run-no-owner';
    db.runs.set(runId, {
      id: runId,
      projectId: PROJECT_ID,
      kind: 'full',
      status: 'succeeded',
      options: DEFAULT_RUN_OPTIONS,
      baseRunId: null,
      targetNodeId: null,
      exitCode: 0,
      error: null,
      totalTokens: null,
      totalCostUsd: null,
      resumable: true,
      queuedAt: '2026-09-07T00:00:00Z',
      startedAt: '2026-09-07T00:00:01Z',
      finishedAt: '2026-09-07T00:00:02Z',
      startedById: null,
      startedByName: null,
    });

    renderRouterApp(`/p/${PROJECT_ID}/runs/${runId}`);
    expect(await screen.findByText(/Started by —/)).toBeInTheDocument();
  });

  it('cancelling an active run flips its status and disables further cancellation', async () => {
    const user = userEvent.setup();
    const runId = 'run-active-1';
    db.runs.set(runId, {
      id: runId,
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
      queuedAt: '2026-09-07T00:00:00Z',
      startedAt: '2026-09-07T00:00:01Z',
      finishedAt: null,
    });

    renderRouterApp(`/p/${PROJECT_ID}/runs/${runId}`);
    await screen.findByText('Running');

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    await user.click(screen.getByRole('button', { name: 'Cancel run' }));

    await waitFor(() => expect(screen.getByText('Cancelled')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
  });

  it('shows a "Regenerate again" action for a regenerate_section run, linking back to the node', async () => {
    const runId = 'run-regen-1';
    db.runs.set(runId, {
      id: runId,
      projectId: PROJECT_ID,
      kind: 'regenerate_section',
      status: 'succeeded',
      options: DEFAULT_RUN_OPTIONS,
      baseRunId: RUN_ID,
      targetNodeId: 'sec-1-2',
      exitCode: 0,
      error: null,
      totalTokens: 500,
      totalCostUsd: 0.02,
      resumable: true,
      queuedAt: '2026-09-07T00:00:00Z',
      startedAt: '2026-09-07T00:00:01Z',
      finishedAt: '2026-09-07T00:00:02Z',
    });

    renderRouterApp(`/p/${PROJECT_ID}/runs/${runId}`);
    expect(await screen.findByRole('button', { name: /regenerate again/i })).toBeInTheDocument();
  });

  it('renders the run error when the run failed', async () => {
    const runId = 'run-failed-1';
    db.runs.set(runId, {
      id: runId,
      projectId: PROJECT_ID,
      kind: 'full',
      status: 'failed',
      options: DEFAULT_RUN_OPTIONS,
      baseRunId: null,
      targetNodeId: null,
      exitCode: 1,
      error: 'CLI exited with code 1',
      totalTokens: null,
      totalCostUsd: null,
      resumable: false,
      queuedAt: '2026-09-07T00:00:00Z',
      startedAt: '2026-09-07T00:00:01Z',
      finishedAt: '2026-09-07T00:00:02Z',
    });

    renderRouterApp(`/p/${PROJECT_ID}/runs/${runId}`);
    expect(await screen.findByText('CLI exited with code 1')).toBeInTheDocument();
    expect(screen.queryByText('Resumable')).not.toBeInTheDocument();
  });
});
