import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/mocks/db';
import { MOCK_USER } from '@/mocks/fixtures';
import { renderWithProviders } from '@/test/component-test-utils';

import type { MarginCardContext } from './card-registry';
import { MarginCard } from './margin-card';
import { makeComment, makeThread } from './test-helpers';

const CTX: MarginCardContext = {
  projectId: 'book-reinforcement-learning',
  nodeId: 'rl-sec-1-1',
  currentUserId: MOCK_USER.id,
  copilotActions: false,
  restoreEditorFocus: vi.fn(),
  applyServerContent: vi.fn(),
  hasUnsavedEdits: () => false,
};

/** Seeds the mock API with a thread (so the real mutations have rows to act on) and renders its card. */
function renderCard(
  options: {
    ownRoot?: boolean;
    replies?: Parameters<typeof makeComment>[0][];
    ctx?: Partial<MarginCardContext>;
    root?: Partial<Parameters<typeof makeComment>[0]>;
  } = {},
) {
  const root = makeComment({
    id: 'root-1',
    bodyMarkdown: 'Is **this** right?',
    authorId: options.ownRoot === false ? 'someone-else' : MOCK_USER.id,
    authorName: options.ownRoot === false ? 'Grace' : MOCK_USER.displayName,
    anchor: { quote: 'the quoted words', prefix: '', suffix: '', start: 4, end: 20 },
    ...options.root,
  });
  const replies = (options.replies ?? []).map((reply, i) =>
    makeComment({
      id: `reply-${i}`,
      threadId: root.id,
      parentId: root.id,
      anchor: root.anchor,
      ...reply,
    }),
  );
  for (const row of [root, ...replies]) db.comments.set(row.id, row);
  const thread = makeThread(root, { replies, range: { start: 4, end: 20 } });
  const view = renderWithProviders(
    <MarginCard
      thread={thread}
      ctx={{ ...CTX, ...options.ctx }}
      register={() => {}}
      top={0}
      focused={false}
      onFocusCard={vi.fn()}
    />,
  );
  return { ...view, root, replies };
}

beforeEach(() => {
  CTX.restoreEditorFocus = vi.fn();
});

describe('comment card', () => {
  it('is a named, focusable region showing the quote, the message and when it was written', async () => {
    renderCard();
    // The Markdown renderer is loaded lazily; the text shows meanwhile.
    expect((await screen.findByText('this')).tagName).toBe('STRONG');
    const card = screen.getByRole('region', {
      name: 'Comment by Ada Researcher on “the quoted words”',
    });
    expect(card).toHaveAttribute('tabindex', '0');
    expect(within(card).getByText('the quoted words')).toBeInTheDocument();
    expect(within(card).getByText('5 min ago')).toBeInTheDocument();
    expect(within(card).queryByText(/edited/)).not.toBeInTheDocument();
  });

  it('never renders typed HTML from a collaborator as markup', () => {
    renderCard({ root: { bodyMarkdown: 'hi <img src=x onerror=alert(1)> <b>raw</b>' } });
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });

  it('replies from the card and files the reply under the thread', async () => {
    const user = userEvent.setup();
    const { root } = renderCard();
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    const box = screen.getByRole('textbox', { name: 'Reply' });
    expect(box).toHaveFocus();
    await user.type(box, 'Yes, because of X.');
    await user.click(screen.getAllByRole('button', { name: 'Reply' }).at(-1)!);
    await waitFor(() => {
      const reply = [...db.comments.values()].find((row) => row.parentId === root.id);
      expect(reply?.bodyMarkdown).toBe('Yes, because of X.');
      expect(reply?.threadId).toBe(root.id);
    });
  });

  it('cancels a reply with Escape and returns focus to the text', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Reply' })).not.toBeInTheDocument();
    expect(CTX.restoreEditorFocus).toHaveBeenCalled();
  });

  it('resolves and reopens', async () => {
    const user = userEvent.setup();
    const { root } = renderCard();
    await user.click(screen.getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(db.comments.get(root.id)?.status).toBe('resolved'));
  });

  it('shows Reopen on a resolved thread', async () => {
    const user = userEvent.setup();
    const { root } = renderCard({ root: { status: 'resolved' } });
    expect(screen.getByText('Resolved')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(db.comments.get(root.id)?.status).toBe('open'));
  });

  it('lets the author edit and delete their own messages, and only those', async () => {
    const user = userEvent.setup();
    renderCard({
      replies: [
        { bodyMarkdown: 'my reply', authorId: MOCK_USER.id, authorName: MOCK_USER.displayName },
        { bodyMarkdown: 'their reply', authorId: 'someone-else', authorName: 'Grace' },
      ],
    });
    expect(screen.getAllByRole('button', { name: /^Edit comment by/ })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Edit comment by Grace' })).not.toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Edit comment by Ada Researcher' })[1]!);
    const box = screen.getByRole('textbox', { name: 'Edit comment by Ada Researcher' });
    expect(box).toHaveValue('my reply');
    await user.clear(box);
    await user.type(box, 'my better reply');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(db.comments.get('reply-0')?.bodyMarkdown).toBe('my better reply'));
    expect(db.comments.get('reply-0')?.editedAt).toBeTruthy();

    await user.click(
      screen.getAllByRole('button', { name: 'Delete comment by Ada Researcher' })[1]!,
    );
    await waitFor(() => expect(db.comments.has('reply-0')).toBe(false));
    expect(db.comments.has('reply-1')).toBe(true);
  });

  it('marks edited messages', () => {
    renderCard({ root: { editedAt: new Date().toISOString() } });
    expect(screen.getByText('· edited')).toBeInTheDocument();
  });

  it('asks before deleting a thread that has replies, then removes all of it', async () => {
    const user = userEvent.setup();
    const { root } = renderCard({ replies: [{ bodyMarkdown: 'a reply' }] });
    await user.click(
      screen.getAllByRole('button', { name: 'Delete comment by Ada Researcher' })[0]!,
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('also deletes 1 reply');
    expect(db.comments.has(root.id)).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Delete thread' }));
    await waitFor(() => expect(db.comments.has(root.id)).toBe(false));
    expect(db.comments.has('reply-0')).toBe(false);
  });

  it("offers no edit or delete on someone else's message", () => {
    renderCard({ ownRoot: false });
    expect(screen.queryByRole('button', { name: /^Edit comment/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete comment/ })).not.toBeInTheDocument();
  });

  it('hides Send to Copilot until the copilot flag is on', () => {
    const { unmount } = renderCard();
    expect(screen.queryByRole('button', { name: 'Send to Copilot' })).not.toBeInTheDocument();
    unmount();
    renderCard({ ctx: { copilotActions: true } });
    expect(screen.getByRole('button', { name: 'Send to Copilot' })).toBeInTheDocument();
  });

  it('renders suggestion and review cards read-only instead of dropping them', () => {
    renderCard({
      root: { kind: 'review', bodyMarkdown: 'Missing a proof.', authorId: null, authorName: null },
    });
    const card = screen.getByRole('region', { name: /^Review on/ });
    expect(within(card).getByText('Missing a proof.')).toBeInTheDocument();
    expect(within(card).getByText('open')).toBeInTheDocument();
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
  });
});
