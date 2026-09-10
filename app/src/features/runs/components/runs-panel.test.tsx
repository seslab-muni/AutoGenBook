import userEvent from '@testing-library/user-event';
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeRunEvents } from '@/api/sse';
import { db } from '@/mocks/db';
import { MOCK_USER } from '@/mocks/fixtures';
import { useUiStore } from '@/stores/ui-store';
import { renderRouterApp } from '@/test/router-test-utils';
import { DEFAULT_RUN_OPTIONS } from '@/test/run-options-fixture';

// See `app-header.test.tsx` / `use-run-stream.test.ts` for why SSE is mocked wherever the
// project layout mounts (it always mounts `useProjectRuns`, hence `useRunStream`).
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

describe('RunsPanel "Started by" column', () => {
  it("shows the run's startedByName, or — when it has none", async () => {
    db.runs.set('run-no-owner', {
      id: 'run-no-owner',
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
      retryable: false,
      queuedAt: '2026-09-06T00:00:00Z',
      startedAt: '2026-09-06T00:00:01Z',
      finishedAt: '2026-09-06T00:00:02Z',
      startedById: null,
      startedByName: null,
    });

    const user = userEvent.setup();
    renderRouterApp(`/p/${PROJECT_ID}`);
    await screen.findByRole('heading', { name: /Distributed Consensus/i });

    await user.click(screen.getByRole('button', { name: /run history/i }));
    const dialog = await screen.findByRole('dialog', { name: /run history/i });

    const rows = within(dialog)
      .getAllByText('Full run')
      .map((link) => link.closest('tr') as HTMLElement);
    expect(rows).toHaveLength(2);

    // Seeded in `mocks/fixtures.ts` for a project with `hasCompletedRun: true`.
    const seededRow = rows.find((row) => within(row).queryByText(MOCK_USER.displayName));
    expect(seededRow).toBeDefined();

    const noOwnerRow = rows.find((row) => row !== seededRow) as HTMLElement;
    // Column order: Kind, Status, Started, Started by, Duration, Tokens, Cost.
    const startedByCell = within(noOwnerRow).getAllByRole('cell')[3];
    expect(startedByCell).toHaveTextContent('—');
  });
});

describe('RunsPanel queue (issue #134)', () => {
  function seedRun(id: string, status: 'running' | 'queued', queuedAt: string) {
    db.runs.set(id, {
      id,
      projectId: PROJECT_ID,
      kind: 'full',
      status,
      options: DEFAULT_RUN_OPTIONS,
      baseRunId: null,
      targetNodeId: null,
      exitCode: null,
      error: null,
      totalTokens: null,
      totalCostUsd: null,
      resumable: true,
      retryable: false,
      queuedAt,
      startedAt: status === 'running' ? queuedAt : null,
      finishedAt: null,
      startedById: MOCK_USER.id,
      startedByName: MOCK_USER.displayName,
    });
  }

  it("shows each queued row's position, and no cancel action for terminal rows", async () => {
    seedRun('run-running', 'running', '2026-09-06T00:00:00Z');
    seedRun('run-queued-1', 'queued', '2026-09-06T00:01:00Z');
    seedRun('run-queued-2', 'queued', '2026-09-06T00:02:00Z');

    renderRouterApp(`/p/${PROJECT_ID}`);
    await screen.findByRole('heading', { name: /Distributed Consensus/i });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /run history/i }));
    const dialog = await screen.findByRole('dialog', { name: /run history/i });

    expect(await within(dialog).findByText('Queued · #1')).toBeInTheDocument();
    expect(within(dialog).getByText('Queued · #2')).toBeInTheDocument();
    expect(within(dialog).getByText('Running')).toBeInTheDocument();

    // Every row this test seeded is queued/running, so each gets a Cancel action; the one
    // seeded succeeded run from `hasCompletedRun: true` (`mocks/fixtures.ts`) does not.
    expect(within(dialog).getAllByRole('button', { name: /^cancel /i })).toHaveLength(3);
  });

  it('cancels a queued row from its own Cancel action', async () => {
    seedRun('run-running', 'running', '2026-09-06T00:00:00Z');
    seedRun('run-queued-1', 'queued', '2026-09-06T00:01:00Z');

    renderRouterApp(`/p/${PROJECT_ID}`);
    await screen.findByRole('heading', { name: /Distributed Consensus/i });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /run history/i }));
    const dialog = await screen.findByRole('dialog', { name: /run history/i });
    const queuedRow = (await within(dialog).findByText('Queued · #1')).closest('tr') as HTMLElement;

    await user.click(within(queuedRow).getByRole('button', { name: /^cancel /i }));
    await user.click(await screen.findByRole('button', { name: 'Cancel run' }));

    await screen.findByText('Run cancelled');
    expect(db.runs.get('run-queued-1')?.status).toBe('cancelled');
    // The project's running slot was untouched by cancelling a different, queued run.
    expect(db.runs.get('run-running')?.status).toBe('running');
  });
});
