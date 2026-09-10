import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeRunEvents } from '@/api/sse';
import type { Run } from '@/api/types';
import { db } from '@/mocks/db';
import { renderWithProviders } from '@/test/component-test-utils';
import { DEFAULT_RUN_OPTIONS } from '@/test/run-options-fixture';

import { OutlinePane } from './outline-pane';
import { STRUCTURE_LOCKED_MESSAGE } from './outline-row';

// `useProjectRuns` (mounted by `OutlinePane`) keeps a live SSE subscription open for any active run
// via `useRunStream` — mocked the same way as `copilot-panel.test.tsx`/`start-run-dialog.test.tsx`.
vi.mock('@/api/sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sse')>();
  return { ...actual, subscribeRunEvents: vi.fn() };
});

const mockedSubscribe = vi.mocked(subscribeRunEvents);

// A chapter with a previous *and* a next sibling, so "Move up", "Move down" and "Indent" are all
// enabled by tree position alone — isolating the run-active gating from position-based disabling.
const PROJECT_ID = 'book-consensus-quantum-2026';
const MIDDLE_CHAPTER_TITLE = 'Quantum State Sharing & Stabilizer Codes';

function seedActiveRun(projectId: string): Run {
  const run: Run = {
    id: 'active-run-1',
    projectId,
    kind: 'full',
    status: 'running',
    options: { ...DEFAULT_RUN_OPTIONS, allowSubdivision: false },
    baseRunId: null,
    targetNodeId: null,
    exitCode: null,
    error: null,
    totalTokens: null,
    totalCostUsd: null,
    resumable: true,
    retryable: false,
    queuedAt: '2026-09-08T00:00:00Z',
    startedAt: '2026-09-08T00:00:01Z',
    finishedAt: null,
  };
  db.runs.set(run.id, run);
  return run;
}

beforeEach(() => {
  mockedSubscribe.mockReset();
  mockedSubscribe.mockReturnValue(vi.fn());
});

function renderPane() {
  return renderWithProviders(
    <OutlinePane
      projectId={PROJECT_ID}
      maxOutlineLevels={3}
      selectedNodeId={null}
      onSelectNode={() => {}}
    />,
  );
}

async function findRow(title: string): Promise<HTMLElement> {
  const label = await screen.findByText(title);
  const row = label.closest('[role="treeitem"]');
  if (!row) throw new Error(`could not find a treeitem row for "${title}"`);
  return row as HTMLElement;
}

describe('OutlinePane structural-edit gating (issue #74)', () => {
  it('disables add/delete/move controls and shows an explanation while a run is active', async () => {
    seedActiveRun(PROJECT_ID);
    renderPane();

    // Wait for the active-run query to resolve before asserting on its effects.
    await screen.findByText(STRUCTURE_LOCKED_MESSAGE);

    // Toolbar and empty-outline "author outline" actions.
    expect(screen.getByRole('button', { name: /add chapter/i })).toBeDisabled();

    // Per-row hover controls (add sub-section / delete) are disabled with the same explanation.
    const rowEl = await findRow(MIDDLE_CHAPTER_TITLE);
    const row = within(rowEl);
    const lockedButtons = row.getAllByTitle(STRUCTURE_LOCKED_MESSAGE);
    expect(lockedButtons.length).toBeGreaterThan(0);
    for (const button of lockedButtons) expect(button).toBeDisabled();

    // The context menu's move/indent/delete items are disabled too, even though this chapter's
    // tree position alone would otherwise allow all of them.
    fireEvent.contextMenu(rowEl);
    expect(await screen.findByRole('menuitem', { name: 'Move up' })).toHaveAttribute(
      'data-disabled',
      '',
    );
    expect(screen.getByRole('menuitem', { name: 'Move down' })).toHaveAttribute(
      'data-disabled',
      '',
    );
    expect(screen.getByRole('menuitem', { name: 'Indent' })).toHaveAttribute('data-disabled', '');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveAttribute('data-disabled', '');

    // Rename/lock/properties stay enabled — the backend still allows non-structural edits.
    expect(screen.getByRole('menuitem', { name: 'Properties' })).not.toHaveAttribute(
      'data-disabled',
    );
    expect(screen.getByRole('menuitem', { name: /lock structure/i })).not.toHaveAttribute(
      'data-disabled',
    );
  });

  it('leaves the controls enabled and hides the banner when no run is active', async () => {
    renderPane();

    const rowEl = await findRow(MIDDLE_CHAPTER_TITLE);
    const row = within(rowEl);
    expect(screen.getByRole('button', { name: /add chapter/i })).not.toBeDisabled();
    expect(screen.queryByText(STRUCTURE_LOCKED_MESSAGE)).not.toBeInTheDocument();
    expect(row.getByTitle('Add sub-section')).not.toBeDisabled();
    expect(row.getByTitle('Delete')).not.toBeDisabled();

    fireEvent.contextMenu(rowEl);
    expect(await screen.findByRole('menuitem', { name: 'Move up' })).not.toHaveAttribute(
      'data-disabled',
    );
    expect(screen.getByRole('menuitem', { name: 'Move down' })).not.toHaveAttribute(
      'data-disabled',
    );
    expect(screen.getByRole('menuitem', { name: 'Indent' })).not.toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).not.toHaveAttribute('data-disabled');
  });
});

describe('OutlinePane filter (issue #115)', () => {
  it('prunes the tree to matches and their ancestors, and updates the match count', async () => {
    const { container } = renderPane();
    await findRow(MIDDLE_CHAPTER_TITLE);

    const filterInput = screen.getByRole('textbox', { name: /filter outline sections/i });
    fireEvent.change(filterInput, { target: { value: 'Quantum Byzantine' } });

    // Debounced — wait for the unrelated chapter to be pruned out before asserting further.
    await waitFor(() => {
      expect(
        screen.queryByText('Foundations of Classical Asynchronous Consensus'),
      ).not.toBeInTheDocument();
    });

    // The match itself (its title now rendered as a highlighted, non-`getByText`-friendly span —
    // matched by `data-node-id` instead) and its ancestor chapter stay visible.
    expect(container.querySelector('[data-node-id="sec-2-2"]')).toBeInTheDocument();
    await findRow(MIDDLE_CHAPTER_TITLE);

    expect(screen.getByText('1 of 9 nodes')).toBeInTheDocument();

    // Clearing the filter restores the full tree.
    fireEvent.change(filterInput, { target: { value: '' } });
    await screen.findByText('Foundations of Classical Asynchronous Consensus');
    expect(await screen.findByText('9 nodes')).toBeInTheDocument();
  });

  it('shows a "No sections match" empty state for a query with no hits', async () => {
    renderPane();
    await findRow(MIDDLE_CHAPTER_TITLE);

    const filterInput = screen.getByRole('textbox', { name: /filter outline sections/i });
    fireEvent.change(filterInput, { target: { value: 'no such section exists' } });

    expect(await screen.findByText('No sections match')).toBeInTheDocument();
    expect(screen.getByText('0 of 9 nodes')).toBeInTheDocument();
  });
});

describe('OutlinePane expand all / collapse all (issue #115)', () => {
  it('collapse all hides child rows, expand all restores them', async () => {
    renderPane();
    await findRow(MIDDLE_CHAPTER_TITLE);
    await findRow('Surface Code Syndrome Extraction Cycles');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryByText('Surface Code Syndrome Extraction Cycles')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    await findRow('Surface Code Syndrome Extraction Cycles');
  });
});
