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
// project layout mounts (it always mounts `useActiveRun`, hence `useRunStream`).
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
