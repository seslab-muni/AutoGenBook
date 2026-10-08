import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { editorInternals } from '@/features/editor/wysiwyg/dom-test-utils';
import { posOf, press, select, type } from '@/features/editor/wysiwyg/test-harness';
import { db } from '@/mocks/db';
import { server } from '@/mocks/server';
import { useEditorStore } from '@/stores/editor-store';
import { renderRouterApp } from '@/test/router-test-utils';

// One test per file for routed studio tests that mount the manuscript chunk: see
// `manuscript-sheet-readonly.route.test.tsx`.
const LONG = { timeout: 10000 };

beforeEach(() => useEditorStore.setState({ view: 'write' }));

describe('Studio editor pane (routed) — the section changes elsewhere while it is edited in Write', () => {
  it('keeps the typed text, holds autosave, and lets the writer load the other version without undo bringing the old one back', async () => {
    const user = userEvent.setup();
    const patches: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PATCH' && request.url.includes('/outline/'))
        patches.push(request.url);
    });
    const { queryClient } = renderRouterApp('/p/book-reinforcement-learning?node=rl-sec-1-1');
    await waitFor(() => {
      if (!document.querySelector('.md-editor')) throw new Error('the editor is not mounted yet');
    }, LONG);

    const { view } = editorInternals();
    act(() => {
      select(view, posOf(view, 'Because'));
      type(view, 'MINE ');
    });
    const node = db.outlineNodes.get('rl-sec-1-1')!;
    const other = `OTHER USER WROTE THIS\n\n${node.contentMarkdown}`;
    db.outlineNodes.set(node.id, {
      ...node,
      contentMarkdown: other,
      contentHash: 'other-user-hash',
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await act(async () => {
      await queryClient.invalidateQueries();
    });

    // The notice appears, the typed text stays, and nothing is saved over the other version.
    expect(
      await screen.findByText(/This section was changed elsewhere/, {}, LONG),
    ).toBeInTheDocument();
    expect(editorInternals().core.text).toContain('MINE Because');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(patches).toHaveLength(0);

    // Load the other version: the editor shows it, and Ctrl+Z cannot bring the replaced text back.
    await user.click(screen.getByRole('button', { name: 'Load the other version' }));
    await waitFor(() => expect(editorInternals().core.text).toBe(other), LONG);
    expect(screen.getByRole('textbox', { name: 'Section text' })).toHaveTextContent(
      'OTHER USER WROTE THIS',
    );
    expect(screen.queryByText(/This section was changed elsewhere/)).not.toBeInTheDocument();
    act(() => {
      press(editorInternals().view, 'z', { ctrl: true });
    });
    expect(editorInternals().core.text).toBe(other);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(patches).toHaveLength(0);

    // Typing again saves, based on the other version.
    act(() => {
      const v = editorInternals().view;
      select(v, posOf(v, 'OTHER', 5));
      type(v, '!');
    });
    await waitFor(() => expect(patches).toHaveLength(1), LONG);
    expect(within(document.body).queryByRole('alert')).not.toBeInTheDocument();
  }, 40000);
});
