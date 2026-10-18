import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { editorInternals } from '@/features/editor/wysiwyg/dom-test-utils';
import { posOf, select, type } from '@/features/editor/wysiwyg/test-harness';
import { server } from '@/mocks/server';
import { useEditorStore } from '@/stores/editor-store';
import { renderRouterApp } from '@/test/router-test-utils';

// One test per file for routed studio tests that mount the manuscript chunk: see
// `manuscript-sheet-readonly.route.test.tsx`.
const LONG = { timeout: 10000 };

beforeEach(() => useEditorStore.setState({ view: 'write' }));

describe('Studio editor pane (routed) — leaving the section with an unsaved edit made in Write', () => {
  it('asks first, keeps the text on Stay, and sends nothing on Leave and discard', async () => {
    const user = userEvent.setup();
    const patches: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PATCH') patches.push(request.url);
    });
    renderRouterApp('/p/book-reinforcement-learning?node=rl-sec-1-1');
    await waitFor(() => {
      if (!document.querySelector('.md-editor')) throw new Error('the editor is not mounted yet');
    }, LONG);

    act(() => {
      const { view } = editorInternals();
      select(view, posOf(view, 'Because'));
      type(view, 'x');
    });
    // Still dirty, well under the debounce: choosing another section is blocked.
    await user.click(
      await screen.findByRole('treeitem', { name: /Multi-Agent Value Factorization/i }, LONG),
    );
    const dialog = await screen.findByRole('alertdialog', undefined, LONG);
    expect(dialog).toHaveTextContent(/edits that are not saved/i);

    await user.click(within(dialog).getByRole('button', { name: 'Stay' }));
    expect(
      await screen.findByRole(
        'treeitem',
        { name: /Policy Iteration & Monotonic Improvement/ },
        LONG,
      ),
    ).toHaveAttribute('aria-selected', 'true');
    expect(editorInternals().core.text).toContain('xBecause');

    // Dirty again, then leave and discard: it moves on and the edit is not saved on the way out.
    act(() => {
      const { view } = editorInternals();
      select(view, posOf(view, 'Because'));
      type(view, 'y');
    });
    await user.click(
      await screen.findByRole('treeitem', { name: /Multi-Agent Value Factorization/i }, LONG),
    );
    const again = await screen.findByRole('alertdialog', undefined, LONG);
    const before = patches.length;
    await user.click(within(again).getByRole('button', { name: 'Leave and discard' }));
    await waitFor(
      () =>
        expect(
          screen.getByRole('treeitem', { name: /Multi-Agent Value Factorization/i }),
        ).toHaveAttribute('aria-selected', 'true'),
      LONG,
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(patches).toHaveLength(before);
  }, 40000);
});
