import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '@/mocks/server';
import { renderRouterApp } from '@/test/router-test-utils';

// `ManuscriptSheet` is a lazily-loaded chunk (CodeMirror + react-markdown/remark/rehype/KaTeX);
// give `findByRole` more room than the default 1000ms rather than risking flakiness.
const LONG = { timeout: 10000 };

describe('Studio editor pane (routed, MSW-backed) — preview and autosave', () => {
  it('renders the selected section in Preview with its server-derived word count', async () => {
    renderRouterApp('/p/book-reinforcement-learning?node=rl-sec-1-1');

    expect(
      await screen.findByRole(
        'heading',
        { level: 1, name: /Policy Iteration & Monotonic Improvement/ },
        LONG,
      ),
    ).toBeInTheDocument();
    // Server `actualWords` (5400), not a locally-recomputed count.
    expect(await screen.findByText('5400 words', {}, LONG)).toBeInTheDocument();
  }, 15000);

  it('collapses a burst of typing in Source view into exactly one PATCH, then shows the updated server word count', async () => {
    const user = userEvent.setup();
    let patchCount = 0;
    server.use(
      http.patch('*/api/v1/projects/:projectId/outline/:nodeId', async ({ request }) => {
        patchCount += 1;
        const body = (await request.json()) as { contentMarkdown?: string };
        return HttpResponse.json({
          id: 'rl-sec-1-1',
          parentId: 'rl-ch-1',
          orderIndex: 0,
          cliKey: '1-1',
          title: 'Policy Iteration & Monotonic Improvement',
          summary: 'x',
          level: 2,
          sectionNumber: '1.1',
          status: 'compiled',
          targetPages: 18,
          wordBudget: 5500,
          actualWords: 3,
          equationDensityLevel: 5,
          mathLevel: 'formal_proof',
          subPrompt: null,
          contentMarkdown: body.contentMarkdown ?? '',
          contentLatex: '',
          ragCitations: [],
          reviewerScore: null,
          reviewerNotes: null,
          structureLocked: true,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        });
      }),
    );

    renderRouterApp('/p/book-reinforcement-learning?node=rl-sec-1-1');
    await screen.findByRole(
      'heading',
      { level: 1, name: /Policy Iteration & Monotonic Improvement/ },
      LONG,
    );

    await user.click(await screen.findByRole('tab', { name: 'Source' }, LONG));
    const editor = await waitFor(() => {
      const el = document.querySelector('.cm-content');
      if (!el) throw new Error('editor not mounted yet');
      return el;
    }, LONG);
    await user.click(editor);
    await user.keyboard('foo bar');

    expect(patchCount).toBe(0);

    await waitFor(() => expect(patchCount).toBe(1), LONG);
    // No PATCH sent twice for the same burst.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(patchCount).toBe(1);

    expect(await screen.findByText('3 words', {}, LONG)).toBeInTheDocument();
  }, 20000);
});
