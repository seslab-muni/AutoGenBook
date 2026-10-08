import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { editorInternals, selectInEditor } from '@/features/editor/wysiwyg/dom-test-utils';
import { posOf, press, select, type } from '@/features/editor/wysiwyg/test-harness';
import { useMarginStore } from '@/features/editor/margin/margin-store';
import { useEditorStore } from '@/stores/editor-store';
import { useUiStore } from '@/stores/ui-store';
import { renderRouterApp } from '@/test/router-test-utils';

// One test per file for routed studio tests that mount the manuscript chunk: see
// `manuscript-sheet-readonly.route.test.tsx`.
const LONG = { timeout: 10000 };

beforeEach(() => {
  useEditorStore.setState({ view: 'write' });
  useUiStore.setState({ marginOpen: true, rightOverlayOpen: false });
  useMarginStore.getState().reset();
});

describe('Margin workspace (routed) — comments in the editable Write view', () => {
  it('comments on a selection, follows typing, orphans when the words are deleted and comes back on undo', async () => {
    const user = userEvent.setup();
    renderRouterApp('/p/book-reinforcement-learning?node=rl-sec-1-1');
    await waitFor(() => {
      if (!document.querySelector('.md-editor')) throw new Error('the editor is not mounted yet');
    }, LONG);
    await screen.findByRole('complementary', { name: 'Margin' }, LONG);

    // Select words in the text: the bar appears, with the source position in the status bar.
    selectInEditor('improvement theorem');
    const bar = await screen.findByRole('toolbar', { name: 'Selection actions' }, LONG);
    expect(await screen.findByText(/^Ln \d+, Col \d+$/, {}, LONG)).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'Comment' }));
    const composer = await screen.findByRole('textbox', { name: 'New comment' });
    await user.type(composer, 'Why this step?{Control>}{Enter}{/Control}');

    const card = await screen.findByRole(
      'region',
      { name: /^Comment by Ada Researcher on “/ },
      LONG,
    );
    expect(card).toHaveTextContent('improvement theorem');
    // The words are highlighted in the editor (marks, where the Custom Highlight API is missing).
    await waitFor(() => {
      const marks = [...document.querySelectorAll('.md-editor mark[data-anchor-ids]')];
      expect(marks.map((m) => m.textContent).join('')).toBe('improvement theorem');
    }, LONG);

    // Clicking the highlight focuses its card.
    const mark = document.querySelector<HTMLElement>('.md-editor mark[data-anchor-ids]')!;
    await user.click(mark);
    await waitFor(() => expect(card).toHaveAttribute('data-focused', 'true'));

    // Text typed before the words shifts the highlight, not its words.
    const { view } = editorInternals();
    act(() => {
      select(view, posOf(view, 'The policy'));
      type(view, 'PREFIX ');
    });
    await waitFor(() => {
      const marks = [...document.querySelectorAll('.md-editor mark[data-anchor-ids]')];
      expect(marks.map((m) => m.textContent).join('')).toBe('improvement theorem');
    });

    // Deleting them leaves the card, flagged orphaned; Ctrl+Z brings the words, the highlight and the card back.
    act(() => {
      const from = posOf(view, 'improvement theorem');
      select(view, from, from + 'improvement theorem'.length);
      press(view, 'Backspace');
    });
    expect(await screen.findByText('Orphaned', {}, LONG)).toBeInTheDocument();
    expect(document.querySelector('.md-editor mark[data-anchor-ids]')).toBeNull();
    act(() => {
      press(view, 'z', { ctrl: true });
    });
    await waitFor(() => {
      const marks = [...document.querySelectorAll('.md-editor mark[data-anchor-ids]')];
      expect(marks.map((m) => m.textContent).join('')).toBe('improvement theorem');
    }, LONG);
    expect(screen.queryByText('Orphaned')).not.toBeInTheDocument();
  }, 40000);
});
