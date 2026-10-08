import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { server } from '@/mocks/server';
import { renderRouterApp } from '@/test/router-test-utils';

// Kept as the only test in this file — see `manuscript-sheet-readonly.route.test.tsx` for why.
const LONG = { timeout: 10000 };

describe('Studio editor pane (routed, MSW-backed) — dirty-route blocker', () => {
  it('blocks navigating to another section while there is an unsaved edit', async () => {
    const user = userEvent.setup();
    const patches: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PATCH') patches.push(request.url);
    });
    renderRouterApp('/p/book-reinforcement-learning?node=rl-sec-1-1');
    await screen.findByRole(
      'heading',
      { level: 1, name: /Policy Iteration & Monotonic Improvement/ },
      LONG,
    );

    await user.click(await screen.findByRole('radio', { name: 'Source' }, LONG));
    const editor = await waitFor(() => {
      const el = document.querySelector('.cm-content');
      if (!el) throw new Error('editor not mounted yet');
      return el;
    }, LONG);
    await user.click(editor);
    await user.keyboard('x');

    // Still dirty (well under the 800ms debounce) — selecting another section is blocked: the
    // outline's selection, and the section still open in the editor, both stay put.
    await user.click(
      await screen.findByRole('treeitem', { name: /Multi-Agent Value Factorization/i }, LONG),
    );

    const dialog = await screen.findByRole('alertdialog', undefined, LONG);
    expect(dialog).toHaveTextContent(/edits that are not saved/i);

    // Stay: the outline's selection and the open section stay put, the edit is kept.
    await user.click(within(dialog).getByRole('button', { name: 'Stay' }));
    const stillSelected = await screen.findByRole(
      'treeitem',
      { name: /Policy Iteration & Monotonic Improvement/ },
      LONG,
    );
    expect(stillSelected).toHaveAttribute('aria-selected', 'true');
    expect(document.querySelector('.cm-content')?.textContent).toContain('x');

    // The pending edit may have been saved while the dialog was up: type again to be dirty.
    await user.click(document.querySelector('.cm-content')!);
    await user.keyboard('y');
    // Leave and discard: moves on, and the pending edit is not saved on the way out.
    await user.click(
      await screen.findByRole('treeitem', { name: /Multi-Agent Value Factorization/i }, LONG),
    );
    const again = await screen.findByRole('alertdialog', undefined, LONG);
    const savedBefore = patches.length;
    await user.click(within(again).getByRole('button', { name: 'Leave and discard' }));
    await waitFor(
      () =>
        expect(
          screen.getByRole('treeitem', { name: /Multi-Agent Value Factorization/i }),
        ).toHaveAttribute('aria-selected', 'true'),
      LONG,
    );
    await new Promise((r) => setTimeout(r, 1200)); // past the 800 ms debounce
    expect(patches).toHaveLength(savedBefore);
  }, 15000);
});
