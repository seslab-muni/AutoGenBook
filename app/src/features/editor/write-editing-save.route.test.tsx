import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { editorInternals } from '@/features/editor/wysiwyg/dom-test-utils';
import { press, select, type } from '@/features/editor/wysiwyg/test-harness';
import { db } from '@/mocks/db';
import { server } from '@/mocks/server';
import { useEditorStore } from '@/stores/editor-store';
import { renderRouterApp } from '@/test/router-test-utils';

// One test per file for routed studio tests that mount the manuscript chunk: see
// `manuscript-sheet-readonly.route.test.tsx`.
const LONG = { timeout: 10000 };

beforeEach(() => useEditorStore.setState({ view: 'write' }));

describe('Studio editor pane (routed) — editing in the Write view', () => {
  it('saves nothing for opening and moving around, and one PATCH with only the edited block for typing', async () => {
    const bodies: { contentMarkdown?: string; expectedContentHash?: string }[] = [];
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'PATCH' && request.url.includes('/outline/')) {
        bodies.push((await request.clone().json()) as (typeof bodies)[number]);
      }
    });
    const original = db.outlineNodes.get('rl-sec-1-1')!.contentMarkdown;

    renderRouterApp('/p/book-reinforcement-learning?node=rl-sec-1-1');
    await waitFor(() => {
      if (!document.querySelector('.md-editor')) throw new Error('the editor is not mounted yet');
    }, LONG);
    expect(screen.getByRole('textbox', { name: 'Section text' })).toHaveAttribute(
      'contenteditable',
      'true',
    );

    // Open, focus, move the caret: nothing is sent, however long we wait (past the 800 ms debounce).
    const { view } = editorInternals();
    act(() => {
      view.focus();
      select(view, 5);
      select(view, 9, 14);
    });
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(bodies).toHaveLength(0);
    // The caret readout shows in the Write view now that it has a caret.
    expect(await screen.findByText(/^Ln \d+, Col \d+$/, {}, LONG)).toBeInTheDocument();

    // Type in the middle of the second paragraph: one save, the hash of what the draft was based on, one block changed.
    const at = original.indexOf('The policy improvement');
    act(() => {
      const target = view.state.doc.textContent.indexOf('The policy improvement');
      expect(target).toBeGreaterThan(-1);
      let pos = -1;
      view.state.doc.descendants((node, p) => {
        if (pos < 0 && node.isText && node.text!.startsWith('The policy improvement')) pos = p + 3;
        return pos < 0;
      });
      select(view, pos);
      type(view, ' HELLO');
    });
    await waitFor(() => expect(bodies).toHaveLength(1), LONG);
    const saved = bodies[0]!;
    expect(saved.expectedContentHash).toBeTruthy();
    expect(saved.contentMarkdown).toBe(
      original.slice(0, at + 3) + ' HELLO' + original.slice(at + 3),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(bodies).toHaveLength(1);

    // Ctrl+S saves at once, without waiting for the debounce.
    act(() => {
      type(view, '!');
      press(view, 's', { ctrl: true });
    });
    await waitFor(() => expect(bodies).toHaveLength(2), { timeout: 600 });
    expect(bodies[1]!.contentMarkdown).toContain(' HELLO!');
  }, 30000);
});
