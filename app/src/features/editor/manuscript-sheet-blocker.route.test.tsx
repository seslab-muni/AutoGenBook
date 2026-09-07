import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderRouterApp } from '@/test/router-test-utils';

// Kept as the only test in this file — see `manuscript-sheet-readonly.route.test.tsx` for why.
const LONG = { timeout: 10000 };

describe('Studio editor pane (routed, MSW-backed) — dirty-route blocker', () => {
  it('blocks navigating to another section while there is an unsaved edit', async () => {
    const user = userEvent.setup();
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
    await user.keyboard('x');

    // Still dirty (well under the 800ms debounce) — selecting another section is blocked: the
    // outline's selection, and the section still open in the editor, both stay put.
    await user.click(
      await screen.findByRole('treeitem', { name: /Multi-Agent Value Factorization/i }, LONG),
    );

    const stillSelected = await screen.findByRole(
      'treeitem',
      { name: /Policy Iteration & Monotonic Improvement/ },
      LONG,
    );
    expect(stillSelected).toHaveAttribute('aria-selected', 'true');
    expect(document.querySelector('.cm-content')?.textContent).toContain(
      'Policy Iteration & Monotonic Improvement',
    );
  }, 15000);
});
