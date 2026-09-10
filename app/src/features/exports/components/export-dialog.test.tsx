import userEvent from '@testing-library/user-event';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeRunEvents } from '@/api/sse';
import { db } from '@/mocks/db';
import { useUiStore } from '@/stores/ui-store';
import { renderRouterApp } from '@/test/router-test-utils';
import { DEFAULT_RUN_OPTIONS } from '@/test/run-options-fixture';

// Every route in this suite mounts `ExportDialog`, which (via `RunCostSummary`'s sibling
// `useRunStream` call) opens an SSE subscription for any in-flight export run — mocked per the
// project's convention (see `use-run-stream.test.ts`) rather than relying on real `EventSource`
// support in jsdom. The dialog's own "swap to a download link" behavior is driven by its direct
// polling of `GET /runs/{runId}` (see `export-dialog.tsx`'s `refetchInterval`), so it doesn't
// depend on the mocked stream ever firing.
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

afterEach(() => {
  useUiStore.setState({ activeModal: null });
});

async function openExportDialog() {
  const user = userEvent.setup();
  renderRouterApp(`/p/${PROJECT_ID}`);
  await screen.findByRole('heading', { name: /Distributed Consensus & Quantum Fault/i });
  await user.click(screen.getByRole('button', { name: /^export$/i }));
  await screen.findByRole('heading', { name: 'Export', level: 2 });
  return user;
}

function cardFor(kind: 'markdown' | 'bib' | 'tex' | 'pdf'): HTMLElement {
  return screen.getByTestId(`export-card-${kind}`);
}

describe('ExportDialog', () => {
  it('offers immediate downloads for Markdown/BibTeX and "Build" actions for LaTeX/PDF', async () => {
    await openExportDialog();

    const markdownCard = cardFor('markdown');
    const markdownLink = within(markdownCard).getByRole('link', { name: /download/i });
    expect(markdownLink).toHaveAttribute(
      'href',
      expect.stringContaining(`/api/v1/files/${RUN_ID}-artifact-md/content`),
    );

    const bibCard = cardFor('bib');
    expect(within(bibCard).getByRole('link', { name: /download/i })).toHaveAttribute(
      'href',
      expect.stringContaining(`/api/v1/files/${RUN_ID}-artifact-bib/content`),
    );

    expect(screen.getByRole('button', { name: 'Build LaTeX' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Build PDF' })).toBeInTheDocument();
  });

  it('shows a download link instead of a Build button when the base run already has a tex artifact', async () => {
    const artifacts = db.runArtifacts.get(RUN_ID) ?? [];
    const fileId = `${RUN_ID}-artifact-tex`;
    db.runArtifacts.set(RUN_ID, [
      ...artifacts,
      {
        kind: 'tex',
        relativePath: 'book.tex',
        fileId,
        filename: 'book.tex',
        sizeBytes: 65_536,
        contentType: 'text/x-tex',
      },
    ]);
    db.files.set(fileId, {
      id: fileId,
      filename: 'book.tex',
      contentType: 'text/x-tex',
      sizeBytes: 65_536,
      sha256: fileId,
      kind: 'artifact',
      kbEligible: false,
      createdAt: db.now(),
    });

    await openExportDialog();

    expect(screen.queryByRole('button', { name: 'Build LaTeX' })).not.toBeInTheDocument();
    const latexCard = cardFor('tex');
    expect(within(latexCard).getByRole('link', { name: /download/i })).toHaveAttribute(
      'href',
      expect.stringContaining(`/api/v1/files/${fileId}/content`),
    );
  });

  it('builds a PDF and swaps the card to a download link once the export run succeeds, with no reload', async () => {
    const user = await openExportDialog();

    await user.click(screen.getByRole('button', { name: 'Build PDF' }));
    expect(await screen.findByText(/building/i)).toBeInTheDocument();

    // `driveFakeRun`'s own timeline reaches `succeeded` well under 2s (a 300ms start delay, a
    // 400ms `running` step, a 900ms `succeeded` step) plus a couple of the dialog's 400ms
    // `refetchInterval` polls on top - the generous budget here is headroom against a busy CI
    // runner's real-timer jitter, not the nominal time this ever takes.
    await waitFor(
      () => {
        const pdfCard = cardFor('pdf');
        expect(within(pdfCard).getByRole('link', { name: /download/i })).toBeInTheDocument();
      },
      { timeout: 20000 },
    );
  }, 25000);

  it('shows 409 guidance (and no stuck spinner) when a build is requested while another run is active', async () => {
    db.runs.set('run-active-for-export', {
      id: 'run-active-for-export',
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
      queuedAt: '2026-09-07T00:00:00Z',
      startedAt: '2026-09-07T00:00:01Z',
      finishedAt: null,
    });

    const user = await openExportDialog();
    await user.click(screen.getByRole('button', { name: 'Build PDF' }));

    // Scoped to the dialog itself: the same problem title also surfaces as a global toast
    // (`createQueryClient`'s `MutationCache.onError`), a second, unrelated match for the text.
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText(/already has an active run/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /start a full run/i })).toBeInTheDocument();
    // The build button is still there and clickable - no stuck spinner left behind.
    expect(within(dialog).getByRole('button', { name: 'Build PDF' })).toBeEnabled();
    expect(within(dialog).queryByText(/building/i)).not.toBeInTheDocument();
  });

  it('shows an empty state with a "Start a run" action when the project has no succeeded run', async () => {
    const user = userEvent.setup();
    renderRouterApp('/p/book-reinforcement-learning');
    await screen.findByRole('heading', { name: /Deep Reinforcement Learning/i });

    await user.click(screen.getByRole('button', { name: /^export$/i }));
    expect(await screen.findByText('No succeeded run yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^start a run$/i })).toBeInTheDocument();
  });
});
