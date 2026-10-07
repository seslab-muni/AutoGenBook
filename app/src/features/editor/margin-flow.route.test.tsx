import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from '@codemirror/view';
import { beforeEach, describe, expect, it } from 'vitest';

import { MOCK_USER } from '@/mocks/fixtures';
import { db } from '@/mocks/db';
import { server } from '@/mocks/server';
import { useEditorStore } from '@/stores/editor-store';
import { useMarginStore } from '@/features/editor/margin/margin-store';
import { useUiStore } from '@/stores/ui-store';
import { renderRouterApp } from '@/test/router-test-utils';

// The sheet is a lazily loaded chunk (CodeMirror + react-markdown + KaTeX).
const LONG = { timeout: 10000 };
const NODE_URL = '/p/book-reinforcement-learning?node=rl-sec-1-1';

function editorView(): EditorView {
  const dom = document.querySelector('.cm-editor') as HTMLElement | null;
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) throw new Error('CodeMirror view not mounted');
  return view;
}

beforeEach(() => {
  useEditorStore.setState({ view: 'source' });
  useUiStore.setState({ rightPane: 'margin', copilotOpen: true, rightOverlayOpen: false });
  useMarginStore.getState().reset();
});

describe('Margin workspace (routed, MSW-backed) — comments in the Source view', () => {
  it('select -> Comment -> anchored card -> reply -> resolve, with the outline badge following', async () => {
    const user = userEvent.setup();
    renderRouterApp(NODE_URL);

    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull(), LONG);
    expect(await screen.findByRole('complementary', { name: 'Margin' }, LONG)).toBeInTheDocument();
    expect(screen.getByText(/No comments yet/)).toBeInTheDocument();

    // A selection in the editor shows the floating bar, which carries only `Comment` for now.
    const doc = editorView().state.doc.toString();
    act(() => editorView().dispatch({ selection: { anchor: 2, head: 14 } }));
    const bar = await screen.findByRole('toolbar', { name: 'Selection actions' });
    expect(
      within(bar)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Comment']);

    await user.click(within(bar).getByRole('button', { name: 'Comment' }));
    const composer = await screen.findByRole('textbox', { name: 'New comment' });
    expect(composer).toHaveFocus();
    await user.type(composer, 'Why this step?{Control>}{Enter}{/Control}');

    // The card appears, quoting the selected words, and the row badge counts it.
    const card = await screen.findByRole(
      'region',
      { name: /^Comment by Ada Researcher on “/ },
      LONG,
    );
    expect(card).toHaveTextContent(doc.slice(2, 14));
    expect(card).toHaveTextContent('Why this step?');
    expect(await screen.findByRole('img', { name: '1 open comment' }, LONG)).toBeInTheDocument();
    // The selected words are highlighted in the editor.
    await waitFor(() => expect(document.querySelector('.cm-content .anchor-mark')).not.toBeNull());

    // Reply.
    await user.click(within(card).getByRole('button', { name: 'Reply' }));
    await user.type(
      within(card).getByRole('textbox', { name: 'Reply' }),
      'Because of monotonicity.',
    );
    await user.click(within(card).getByRole('button', { name: 'Reply', hidden: false }));
    await waitFor(() =>
      expect(within(card).getByText('Because of monotonicity.')).toBeInTheDocument(),
    );

    // Resolve: the card leaves the margin and the badge goes away; Show resolved brings it back.
    await user.click(within(card).getByRole('button', { name: 'Resolve' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /^Comment by Ada/ })).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.queryByRole('img', { name: /open comment/ })).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: /Show resolved \(1\)/ }));
    const back = await screen.findByRole('region', { name: /^Comment by Ada/ });
    await user.click(within(back).getByRole('button', { name: 'Reopen' }));
    expect(await screen.findByRole('img', { name: '1 open comment' }, LONG)).toBeInTheDocument();
  }, 30000);

  it('keeps a comment on its words while the text before it is edited, and orphans it when they are deleted', async () => {
    const user = userEvent.setup();
    const doc0 = db.outlineNodes.get('rl-sec-1-1')!.contentMarkdown;
    renderRouterApp(NODE_URL);
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull(), LONG);
    await screen.findByRole('complementary', { name: 'Margin' }, LONG);

    // Inside the first line, so the highlight is one piece of text.
    const from = 2;
    const to = Math.min(doc0.indexOf(String.fromCharCode(10)), 16);
    act(() => editorView().dispatch({ selection: { anchor: from, head: to } }));
    await user.click(await screen.findByRole('button', { name: 'Comment' }));
    await user.type(
      await screen.findByRole('textbox', { name: 'New comment' }),
      'note{Control>}{Enter}{/Control}',
    );
    await screen.findByRole('region', { name: /^Comment by Ada Researcher on “/ }, LONG);

    // Text typed before the range shifts the highlight but not its words.
    act(() => editorView().dispatch({ changes: { from: 0, insert: 'PREFIX ' } }));
    await waitFor(() => {
      const marks = [...document.querySelectorAll('.cm-content .anchor-mark')];
      expect(marks.map((mark) => mark.textContent).join('')).toBe(doc0.slice(from, to));
    });

    // Deleting them leaves the card, flagged orphaned, with its quote.
    act(() => editorView().dispatch({ changes: { from: from + 7, to: to + 7 } }));
    expect(await screen.findByText('Orphaned', {}, LONG)).toBeInTheDocument();
    expect(document.querySelector('.cm-content .anchor-mark')).toBeNull();
    // ...and it stays that way past the autosave and the refetch that brings the server's re-anchor
    // (a new anchor object): still the badge, the note and the struck quote, never a bare pinned card.
    let patched = false;
    server.events.on('request:end', ({ request }) => {
      if (request.method === 'PATCH') patched = true;
    });
    await waitFor(() => expect(patched).toBe(true), LONG);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const card = screen.getByRole('region', { name: /\(orphaned\)/ });
    expect(within(card).getByText('Orphaned')).toBeInTheDocument();
    expect(within(card).getByText(/gone from the section/)).toBeInTheDocument();
    expect(card.querySelector('blockquote')?.className).toContain('line-through');
    expect(MOCK_USER.displayName).toBeTruthy();
  }, 30000);
});
