import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeRunEvents } from '@/api/sse';
import type { OutlineNode, Project } from '@/api/types';
import { db } from '@/mocks/db';
import { renderWithProviders } from '@/test/component-test-utils';

import { CopilotDrawer } from './copilot-drawer';

// See `use-run-stream.test.ts` for why SSE is mocked wherever `useRunStream`/`useProjectRuns` mount
// (as they do here, transitively, via the `copilot` tab's `CopilotPanel`).
vi.mock('@/api/sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sse')>();
  return { ...actual, subscribeRunEvents: vi.fn() };
});

const mockedSubscribe = vi.mocked(subscribeRunEvents);

const PROJECT_ID = 'book-consensus-quantum-2026';
const NODE_ID = 'sec-1-2';

function getProject(): Project {
  return db.projects.get(PROJECT_ID)! as Project;
}

describe('CopilotDrawer', () => {
  beforeEach(() => {
    mockedSubscribe.mockReturnValue(() => {});
  });

  afterEach(() => {
    const node = db.outlineNodes.get(NODE_ID)!;
    db.outlineNodes.set(NODE_ID, { ...node, reviewerScore: null, reviewerNotes: null });
  });

  function renderDrawer(
    tab: 'copilot' | 'citations' | 'review',
    options: { node?: OutlineNode | null; onTabChange?: () => void } = {},
  ) {
    const node = options.node !== undefined ? options.node : db.outlineNodes.get(NODE_ID)!;
    return renderWithProviders(
      <CopilotDrawer
        projectId={PROJECT_ID}
        project={getProject()}
        node={node}
        tab={tab}
        onTabChange={options.onTabChange ?? vi.fn()}
      />,
    );
  }

  it('renders the real Copilot panel content and switches to Citations', async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    renderDrawer('copilot', { onTabChange });

    expect(await screen.findByText('Quick actions')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Citations' }));
    expect(onTabChange).toHaveBeenCalledWith('citations');
  });

  it('shows citations when the citations tab is active and a node is selected', async () => {
    renderDrawer('citations');
    expect(await screen.findByText('Castro & Liskov, 2002')).toBeInTheDocument();
  });

  it('shows an empty state for citations/review when no node is selected', () => {
    renderDrawer('citations', { node: null });
    expect(screen.getByText('No section selected')).toBeInTheDocument();
  });

  it('shows the review tab content when active', async () => {
    const node = db.outlineNodes.get(NODE_ID)!;
    db.outlineNodes.set(NODE_ID, { ...node, reviewerScore: 6, reviewerNotes: 'Good start.' });

    renderDrawer('review');

    expect(await screen.findByText('6.0 / 10')).toBeInTheDocument();
    expect(await screen.findByText('Good start.')).toBeInTheDocument();
  });

  it('shows the selected section in the status bar', async () => {
    renderDrawer('copilot');
    await waitFor(() => {
      expect(
        screen.getByText('§1.2 Byzantine Quorum Intersection & Threshold Bounds'),
      ).toBeInTheDocument();
    });
  });
});
