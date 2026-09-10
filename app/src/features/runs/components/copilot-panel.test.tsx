import userEvent from '@testing-library/user-event';
import { useQuery } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { projects } from '@/api/queries/projects';
import { outline } from '@/api/queries/outline';
import { subscribeRunEvents } from '@/api/sse';
import type { Project } from '@/api/types';
import { db } from '@/mocks/db';
import { renderWithProviders } from '@/test/component-test-utils';
import { useUiStore } from '@/stores/ui-store';

import { CopilotPanel } from './copilot-panel';

// See `use-run-stream.test.ts` for why SSE is mocked wherever `useRunStream`/`useActiveRun` mount.
vi.mock('@/api/sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sse')>();
  return { ...actual, subscribeRunEvents: vi.fn() };
});

const mockedSubscribe = vi.mocked(subscribeRunEvents);

const CONSENSUS_PROJECT_ID = 'book-consensus-quantum-2026';
const RL_PROJECT_ID = 'book-reinforcement-learning';

/**
 * `probeNodeIds` renders each probed node's current `contentMarkdown` from the same
 * `outline.flat` cache `CopilotPanel` invalidates on a `section` event — since the panel itself
 * doesn't render section content (that's the editor's, #20), this is how the test observes that
 * the client actually picked up the refetched data, not just that the mock db was mutated.
 */
function Harness({
  projectId,
  selectedNodeId,
  probeNodeIds = [],
}: {
  projectId: string;
  selectedNodeId: string | null;
  probeNodeIds?: string[];
}) {
  const { data: project } = useQuery(projects.detail(projectId));
  const { data: outlineData } = useQuery(outline.flat(projectId));
  if (!project) return null;
  return (
    <>
      <CopilotPanel
        projectId={projectId}
        project={project as Project}
        selectedNodeId={selectedNodeId}
      />
      {probeNodeIds.map((nodeId) => (
        <div key={nodeId} data-testid={`probe-${nodeId}`}>
          {outlineData?.items.find((item) => item.id === nodeId)?.contentMarkdown}
        </div>
      ))}
    </>
  );
}

beforeEach(() => {
  mockedSubscribe.mockReset();
  mockedSubscribe.mockReturnValue(vi.fn());
});

afterEach(() => {
  useUiStore.setState({ activeModal: null });
});

describe('CopilotPanel', () => {
  it('prompts to select a node when none is selected', async () => {
    renderWithProviders(<Harness projectId={CONSENSUS_PROJECT_ID} selectedNodeId={null} />);
    expect(await screen.findByText(/select a node from the outline tree/i)).toBeInTheDocument();
  });

  it('disables regeneration and explains why for a node with no cli key yet', async () => {
    // The mock's own outline handlers always assign `cliKey` positionally as soon as a node
    // exists (unlike the real backend, which only sets it once a run has processed the node —
    // see `OutlineNode.cliKey`'s doc comment in `docs/openapi.yaml`), so a cliKey-less node has
    // to be forged directly here to exercise this gate.
    const node = db.outlineNodes.get('sec-3-1')!;
    db.outlineNodes.set('sec-3-1', { ...node, cliKey: null });

    renderWithProviders(<Harness projectId={CONSENSUS_PROJECT_ID} selectedNodeId="sec-3-1" />);
    await screen.findByText(/§3\.1/);
    expect(screen.getByRole('button', { name: /regenerate/i })).toBeDisabled();
    expect(screen.getByText(/no cli key yet/i)).toBeInTheDocument();
  });

  it('disables regeneration when the project has no successful prior run', async () => {
    renderWithProviders(<Harness projectId={RL_PROJECT_ID} selectedNodeId="rl-sec-1-1" />);
    await screen.findByText(/Policy Iteration/);
    expect(screen.getByRole('button', { name: /regenerate/i })).toBeDisabled();
    expect(screen.getByText(/start a full run first/i)).toBeInTheDocument();
  });

  it('renders a 409 conflict inline with a "Start full run" action', async () => {
    // Force a stale-resume 409: the client only checks `lastRunId` presence, so make that run
    // exist but not resumable (matching the server's real precondition in `outline.regenerate`).
    const project = db.projects.get(CONSENSUS_PROJECT_ID)!;
    const baseRun = db.runs.get(project.lastRunId!)!;
    db.runs.set(baseRun.id, { ...baseRun, resumable: false });

    const user = userEvent.setup();
    renderWithProviders(<Harness projectId={CONSENSUS_PROJECT_ID} selectedNodeId="sec-1-2" />);
    await screen.findByText(/§1\.2/);

    await user.type(screen.getByPlaceholderText(/type instructions/i), 'add worked examples');
    await user.click(screen.getByRole('button', { name: /regenerate/i }));

    expect(await screen.findByText(/no successful prior run to resume from/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /start full run/i }));
    expect(useUiStore.getState().activeModal).toBe('start-run');
  });

  it('regenerating §1.2 streams a section event that updates only that node', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Harness
        projectId={CONSENSUS_PROJECT_ID}
        selectedNodeId="sec-1-2"
        probeNodeIds={['sec-1-1', 'sec-1-2']}
      />,
    );
    await screen.findByText(/§1\.2/);

    expect(await screen.findByTestId('probe-sec-1-1')).toHaveTextContent(
      'Formal Safety and Liveness Definitions',
    );

    await user.click(screen.getByRole('button', { name: 'Add examples' }));
    expect(screen.getByPlaceholderText(/type instructions/i)).toHaveValue(
      'Insert intuitive pedagogical example and step-by-step exercise.',
    );
    await user.click(screen.getByRole('button', { name: /regenerate/i }));

    await screen.findByText('Queued');
    // The panel also had an ambient subscription to the project's last (already-finished) run,
    // since that's `effectiveRunId`'s fallback before any run is tracked - only the *new*
    // regenerate run matters here.
    const baseRunId = db.projects.get(CONSENSUS_PROJECT_ID)!.lastRunId!;
    const newRunCall = mockedSubscribe.mock.calls.find(([id]) => id !== baseRunId)!;
    const [runId, { onEvent, onDone }] = newRunCall;
    expect(runId).not.toBe(baseRunId);

    // Simulate the server having applied the section's new content, then the one `section`
    // event the mock's regenerate timeline emits for it.
    const node = db.outlineNodes.get('sec-1-2')!;
    db.outlineNodes.set('sec-1-2', {
      ...node,
      status: 'compiled',
      contentMarkdown: 'Added a worked example to §1.2.',
    });
    onEvent(
      {
        seq: 1,
        ts: '2026-09-07T00:00:00Z',
        level: 'info',
        stage: 'section',
        message: 'Section regenerated.',
        payload: { nodeKey: 'sec-1-2' },
      },
      'section',
    );

    // The client picked up the refetched content for sec-1-2 only — sec-1-1 is untouched.
    await waitFor(() =>
      expect(screen.getByTestId('probe-sec-1-2')).toHaveTextContent(
        'Added a worked example to §1.2.',
      ),
    );
    expect(screen.getByTestId('probe-sec-1-1')).toHaveTextContent(
      'Formal Safety and Liveness Definitions',
    );

    db.runs.set(runId, {
      ...db.runs.get(runId)!,
      status: 'succeeded',
      totalTokens: 4200,
      totalCostUsd: 0.08,
    });
    onDone!({
      seq: 2,
      ts: '2026-09-07T00:00:01Z',
      level: 'info',
      stage: 'assembly',
      message: 'Run succeeded.',
    });

    expect(await screen.findByText('Succeeded')).toBeInTheDocument();
    expect(await screen.findByText(/4,200 tokens/)).toBeInTheDocument();
  });
});
