import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeAnchor } from '@/features/editor/lib/anchors';
import { makeComment } from '@/features/editor/margin/test-helpers';
import { useMarginStore } from '@/features/editor/margin/margin-store';
import { db } from '@/mocks/db';
import { useEditorStore } from '@/stores/editor-store';
import { useUiStore } from '@/stores/ui-store';
import { renderRouterApp } from '@/test/router-test-utils';

const LONG = { timeout: 10000 };
const NODE_URL = '/p/book-reinforcement-learning?node=rl-sec-1-1';

beforeEach(() => {
  useEditorStore.setState({ view: 'write' });
  useUiStore.setState({ marginOpen: true, rightOverlayOpen: false });
  useMarginStore.getState().reset();
});

describe('Margin workspace (routed, MSW-backed) — Write view', () => {
  it('highlights a comment, focuses its card on click, and maps a selection back to the source', async () => {
    const user = userEvent.setup();
    const node = db.outlineNodes.get('rl-sec-1-1')!;
    const text = node.contentMarkdown;
    const from = text.indexOf('policy');
    expect(from).toBeGreaterThan(-1);
    const anchor = makeAnchor(text, from, from + 'policy'.length);
    db.comments.set(
      'seed',
      makeComment({
        id: 'seed',
        projectId: node.projectId,
        nodeId: node.id,
        anchor,
        bodyMarkdown: 'Seeded note',
      }),
    );

    renderRouterApp(NODE_URL);
    const mark = await waitFor(() => {
      const el = document.querySelector('mark[data-anchor-ids="seed"]');
      if (!el) throw new Error('no highlight yet');
      return el as HTMLElement;
    }, LONG);
    expect(mark).toHaveTextContent('policy');
    expect(mark.className).toContain('anchor-comment');

    // Clicking the highlight focuses its card; the card's highlight takes the focused style.
    const card = await screen.findByRole(
      'region',
      { name: /^Comment by Ada Researcher on “policy”/ },
      LONG,
    );
    expect(card).not.toHaveAttribute('data-focused');
    await user.click(mark);
    await waitFor(() => expect(card).toHaveAttribute('data-focused', 'true'));
    expect(
      [...document.querySelectorAll('mark[data-anchor-ids="seed"]')].every((el) =>
        el.classList.contains('anchor-focused'),
      ),
    ).toBe(true);
    expect(within(card).getByText('Seeded note')).toBeInTheDocument();

    // A selection in the rendered text publishes its source position and shows the bar.
    const target = [...document.querySelectorAll('[data-src-start]')].find((el) =>
      el.textContent?.includes('policy'),
    )!;
    const textNode = target.firstChild as Text;
    const at = textNode.data.indexOf('policy');
    act(() => {
      const range = document.createRange();
      range.setStart(textNode, at);
      range.setEnd(textNode, at + 6);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(await screen.findByText(/^Ln \d+, Col \d+$/, {}, LONG)).toBeInTheDocument();
    expect(await screen.findByRole('toolbar', { name: 'Selection actions' })).toBeInTheDocument();
    // Escape (with the text focused, as after a click) dismisses the bar.
    act(() => screen.getByRole('region', { name: 'Manuscript' }).focus());
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('toolbar', { name: 'Selection actions' })).not.toBeInTheDocument(),
    );
  }, 30000);
});
