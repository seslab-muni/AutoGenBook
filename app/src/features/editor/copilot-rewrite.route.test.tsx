import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMarginStore } from '@/features/editor/margin/margin-store';
import { DEFAULT_RUN_OPTIONS } from '@/test/run-options-fixture';
import { db, mockRevisionConfig } from '@/mocks/db';
import { server } from '@/mocks/server';
import { useEditorStore } from '@/stores/editor-store';
import { useUiStore } from '@/stores/ui-store';
import { renderRouterApp } from '@/test/router-test-utils';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), message: vi.fn() }));
vi.mock('sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('sonner')>()),
  toast: toasts,
}));
const tracked = vi.hoisted(() => ({ trackRun: vi.fn() }));
vi.mock('@/features/runs/hooks/use-run-stream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/runs/hooks/use-run-stream')>();
  tracked.trackRun.mockImplementation(actual.trackRun);
  return { ...actual, trackRun: tracked.trackRun };
});

const LONG = { timeout: 15000 };
const FINISHED_PROJECT = 'book-consensus-quantum-2026';

beforeEach(() => {
  mockRevisionConfig.stepMs = 5;
  useEditorStore.setState({ view: 'source' });
  useUiStore.setState({ marginOpen: true, rightOverlayOpen: false, activeModal: null });
  useMarginStore.getState().reset();
  useMarginStore.setState({ drafts: {}, promptExtras: {}, savedComposers: {} });
  vi.clearAllMocks();
});
afterEach(() => {
  mockRevisionConfig.stepMs = 700;
});

async function open(path: string) {
  const view = renderRouterApp(path);
  await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull(), LONG);
  await screen.findByRole('complementary', { name: 'Margin' }, LONG);
  return view;
}

describe('Rewrite, up front (routed, MSW-backed)', () => {
  it('on a project that never had a run it says why and offers Start full run, before anything is sent', async () => {
    const user = userEvent.setup();
    await open('/p/book-reinforcement-learning?node=rl-sec-1-1');
    await user.click(screen.getByRole('button', { name: 'Copilot' }));
    const rewrite = await screen.findByRole('radio', { name: 'Rewrite' });
    expect(rewrite).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(/No successful prior run to resume from/)).toBeVisible();
    await user.click(rewrite);
    expect(screen.getByRole('radio', { name: 'Revise' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Start full run' }));
    expect(useUiStore.getState().activeModal).toBe('start-run');
  }, 45000);

  it('a locked section offers Unlock content', async () => {
    const user = userEvent.setup();
    const node = db.outlineNodes.get('sec-1-1')!;
    db.outlineNodes.set('sec-1-1', { ...node, contentLocked: true });
    await open(`/p/${FINISHED_PROJECT}?node=sec-1-1`);
    await user.click(screen.getByRole('button', { name: 'Copilot' }));
    expect(await screen.findByText(/content is locked/)).toBeVisible();
    await user.click(
      within(screen.getByRole('region', { name: 'Prompt the copilot' })).getByRole('button', {
        name: 'Unlock content',
      }),
    );
    await waitFor(() => expect(db.outlineNodes.get('sec-1-1')!.contentLocked).toBe(false), LONG);
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Rewrite' })).not.toHaveAttribute('aria-disabled'),
    );
  }, 45000);

  it('asks before replacing the section, then follows the run it became by its id', async () => {
    const user = userEvent.setup();
    await open(`/p/${FINISHED_PROJECT}?node=sec-1-1`);
    await user.click(screen.getByRole('button', { name: 'Copilot' }));
    await user.click(await screen.findByRole('radio', { name: 'Rewrite' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Instruction for the copilot' }),
      'start over, more formally',
    );
    await user.click(screen.getByRole('button', { name: 'Rewrite' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Rewrite this section?');
    expect(tracked.trackRun).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Rewrite section' }));
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith('Rewrite started', expect.anything()),
    );
    const run = [...db.runs.values()].find((r) => r.kind === 'regenerate_section')!;
    expect(run.options.promptModifier).toBe('start over, more formally');
    // The run is followed directly: a short run could start and end between two polls of the list.
    expect(tracked.trackRun).toHaveBeenCalledWith(run.id, expect.anything(), FINISHED_PROJECT);
  }, 45000);
});

describe('a LaTeX-only section (routed)', () => {
  it('has only Rewrite: the header Copilot opens the window locked to it, and the toolbar offers no Prompt…', async () => {
    const user = userEvent.setup();
    const node = db.outlineNodes.get('sec-1-1')!;
    db.outlineNodes.set('sec-1-1', {
      ...node,
      contentMarkdown: '',
      contentLatex: '\\section{Safety}\nSome LaTeX.',
    });
    await open(`/p/${FINISHED_PROJECT}?node=sec-1-1`);
    const header = screen.getByRole('button', { name: 'Copilot' });
    expect(header).not.toHaveAttribute('aria-disabled');
    await user.click(header);
    expect(await screen.findByRole('radio', { name: 'Rewrite' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Revise' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(/this one holds LaTeX/)).toBeVisible();
    // Nothing to range-revise.
    expect(screen.queryByRole('toolbar', { name: 'Selection actions' })).not.toBeInTheDocument();
  }, 45000);
});

describe('"Regenerate again" on a run page (routed)', () => {
  it('opens the section with the prompt window on Rewrite, filled in with what that run was asked, once', async () => {
    const user = userEvent.setup();
    db.runs.set('run-regen', {
      id: 'run-regen',
      projectId: FINISHED_PROJECT,
      kind: 'regenerate_section',
      status: 'succeeded',
      options: { ...DEFAULT_RUN_OPTIONS, promptModifier: 'be terse' },
      baseRunId: null,
      targetNodeId: 'sec-1-1',
      exitCode: 0,
      error: null,
      totalTokens: null,
      totalCostUsd: null,
      resumable: true,
      retryable: false,
      queuedAt: '2026-09-07T00:00:00Z',
      startedAt: '2026-09-07T00:00:01Z',
      finishedAt: '2026-09-07T00:00:02Z',
      startedById: null,
      startedByName: null,
    });
    const { router } = renderRouterApp(`/p/${FINISHED_PROJECT}/runs/run-regen`);
    await user.click(await screen.findByRole('button', { name: 'Regenerate again' }, LONG));
    const box = await screen.findByRole('textbox', { name: 'Instruction for the copilot' }, LONG);
    expect(box).toHaveValue('be terse');
    expect(screen.getByRole('radio', { name: 'Rewrite' })).toBeChecked();
    // The request to open it was consumed: a reload does not open it again.
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('copilot'));
    expect(router.state.location.search).toMatchObject({ node: 'sec-1-1' });
  }, 45000);
});

describe('old links and old reviews (routed)', () => {
  it('drops ?tab= from the address, not just from the search state', async () => {
    const { router } = await open(`/p/book-reinforcement-learning?node=rl-sec-1-1&tab=review`);
    await waitFor(() => expect(router.state.location.searchStr).not.toContain('tab='));
    expect(router.state.location.search).toEqual({ node: 'rl-sec-1-1' });
  }, 45000);

  it('shows the notes of a section reviewed before review rows existed, as a plain disclosure', async () => {
    const user = userEvent.setup();
    const node = db.outlineNodes.get('sec-1-1')!;
    db.outlineNodes.set('sec-1-1', {
      ...node,
      reviewerNotes: '[minor] terminology: use Systems Dynamics',
      reviewSummary: null,
    });
    await open(`/p/${FINISHED_PROJECT}?node=sec-1-1`);
    const strip = await screen.findByRole('region', { name: 'Review summary' }, LONG);
    await user.click(within(strip).getByRole('button', { name: 'Review notes (previous run)' }));
    expect(screen.getByText('[minor] terminology: use Systems Dynamics')).toBeVisible();
    void act;
    void server;
  }, 45000);

  it('shows no notes disclosure once review cards exist', async () => {
    const { seedReviewDemo } = await import('@/mocks/fixtures');
    seedReviewDemo();
    const node = db.outlineNodes.get('sec-1-1')!;
    db.outlineNodes.set('sec-1-1', { ...node, reviewerNotes: 'old flattened notes' });
    await open(`/p/${FINISHED_PROJECT}?node=sec-1-1`);
    await screen.findByRole('region', { name: 'Review summary' }, LONG);
    expect(
      screen.queryByRole('button', { name: 'Review notes (previous run)' }),
    ).not.toBeInTheDocument();
  }, 45000);
});
