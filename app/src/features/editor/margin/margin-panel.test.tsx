import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/component-test-utils';

import type { MarginCardContext } from './card-registry';
import type { MarginGeometry } from './geometry';
import { MarginPanel } from './margin-panel';
import { useMarginStore } from './margin-store';
import { makeComment, makeThread } from './test-helpers';
import { compareThreads, filterThreads } from './threads';

const CTX: MarginCardContext = {
  projectId: 'book-reinforcement-learning',
  nodeId: 'rl-sec-1-1',
  currentUserId: 'user-mock-1',
  copilotActions: false,
  restoreEditorFocus: vi.fn(),
  applyServerContent: vi.fn(),
  hasUnsavedEdits: () => false,
  flushEdits: () => Promise.resolve(),
};

function geometry(y: Record<string, number>): MarginGeometry {
  const scrollEl = document.createElement('div');
  return {
    scrollEl,
    contentHeight: () => 0,
    setExtraBottom: () => {},
    scrollTop: () => scrollEl.scrollTop,
    scrollBy: (dy) => {
      scrollEl.scrollTop += dy;
    },
    viewportHeight: () => 700,
    measure: (anchors) =>
      new Map(
        anchors
          .filter((anchor) => anchor.id in y)
          .map((a) => [a.id, { y: y[a.id]!, approximate: false }]),
      ),
    reveal: vi.fn(),
    subscribe: () => () => {},
  };
}

const anchored = (id: string, body: string, start: number, extra = {}) =>
  makeThread(
    makeComment({
      id,
      bodyMarkdown: body,
      anchor: { quote: `quote ${id}`, prefix: '', suffix: '', start, end: start + 5 },
      ...extra,
    }),
    { range: { start, end: start + 5 } },
  );

function renderPanel(
  threads: ReturnType<typeof anchored>[],
  y: Record<string, number>,
  extra: Partial<React.ComponentProps<typeof MarginPanel>> = {},
) {
  const state = useMarginStore.getState();
  const visible = filterThreads(threads, state.filter, state.showResolved).sort(compareThreads);
  return renderWithProviders(
    <MarginPanel
      ctx={CTX}
      threads={threads}
      visible={visible}
      loading={false}
      error={false}
      onRetry={vi.fn()}
      composer={null}
      composerRange={null}
      composerQuote=""
      geometry={geometry(y)}
      {...extra}
    />,
  );
}

const tops = () =>
  [...document.querySelectorAll<HTMLElement>('section[data-thread-id]')].map((el) => ({
    id: el.dataset['threadId'],
    top: parseFloat(el.style.top),
  }));

beforeEach(() => useMarginStore.getState().reset());

describe('MarginPanel', () => {
  it('places each card at its anchor and pushes overlapping ones down', async () => {
    renderPanel(
      [anchored('a', 'First', 10), anchored('b', 'Second', 20), anchored('c', 'Far', 20)],
      {
        a: 40,
        b: 60,
        c: 900,
      },
    );
    await waitFor(() => expect(tops()).toHaveLength(3));
    await waitFor(() => {
      const byId = Object.fromEntries(tops().map((t) => [t.id, t.top]));
      expect(byId['a']).toBe(40);
      expect(byId['b']).toBeGreaterThan(40 + 100); // below card a (default height 120 + gap)
      expect(byId['c']).toBe(900);
    });
  });

  it('pins section-level and orphaned cards at the top, ahead of anchored ones', async () => {
    const section = makeThread(makeComment({ id: 's', bodyMarkdown: 'About everything' }));
    const orphan = makeThread(
      makeComment({
        id: 'o',
        status: 'orphaned',
        bodyMarkdown: 'Lost',
        anchor: { quote: 'gone words', prefix: '', suffix: '', start: null, end: null },
      }),
    );
    renderPanel([anchored('a', 'Anchored', 3), section, orphan], { a: 30 });
    await waitFor(() => expect(tops()).toHaveLength(3));
    await waitFor(() => {
      const ordered = [...tops()].sort((x, y) => x.top - y.top).map((t) => t.id);
      expect(ordered).toEqual(['s', 'o', 'a']);
    });
    const card = screen.getByRole('region', { name: /\(orphaned\)/ });
    expect(within(card).getByText('Orphaned')).toBeInTheDocument();
    expect(within(card).getByText('gone words')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: /whole section/ })).getByText('Whole section'),
    ).toBeInTheDocument();
  });

  it('hides resolved threads until asked, and filters by kind', async () => {
    const user = userEvent.setup();
    const resolved = anchored('r', 'Done already', 5, { status: 'resolved' });
    const review = anchored('v', 'Reviewer says no', 8, { kind: 'review' });
    const threads = [anchored('a', 'Open one', 1), resolved, review];
    renderPanel(threads, { a: 10, r: 20, v: 30 });
    expect(screen.queryByText('Done already')).not.toBeInTheDocument();
    // Unsupported kinds are shown read-only rather than dropped.
    expect(screen.getByText('Reviewer says no')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show resolved (1)' }));
    expect(useMarginStore.getState().showResolved).toBe(true);
    await user.click(screen.getByRole('radio', { name: 'Comments' }));
    expect(useMarginStore.getState().filter).toBe('comment');
  });

  it('shows the empty state, an error with retry, and the composer for a whole-section comment', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { unmount } = renderPanel([], {}, { error: true, onRetry });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
    unmount();

    renderPanel([], {});
    expect(screen.getByText(/No comments yet/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Comment on the whole section' }));
    expect(useMarginStore.getState().composer).toEqual({ kind: 'comment', anchor: null });
  });

  it('renders the composer card at the selection and cancels with Escape', async () => {
    const user = userEvent.setup();
    useMarginStore.getState().openComposer({
      kind: 'comment',
      anchor: { quote: 'picked', prefix: '', suffix: '', start: 3, end: 9 },
    });
    renderPanel(
      [],
      { draft: 77 },
      {
        composer: useMarginStore.getState().composer,
        composerRange: { start: 3, end: 9 },
        composerQuote: 'picked',
      },
    );
    const box = await screen.findByRole('textbox', { name: 'New comment' });
    expect(box).toHaveFocus();
    expect(screen.getByText('picked')).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'New comment' });
    await waitFor(() => expect(parseFloat(card.style.top)).toBe(77));
    await user.keyboard('{Escape}');
    expect(useMarginStore.getState().composer).toBeNull();
    expect(CTX.restoreEditorFocus).toHaveBeenCalled();
  });
});
