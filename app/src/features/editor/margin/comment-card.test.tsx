import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/mocks/db';
import { MOCK_USER } from '@/mocks/fixtures';
import { renderWithProviders } from '@/test/component-test-utils';

import { toServerAnchor } from '@/features/editor/lib/server-anchor';
import type { MarginCardContext } from './card-registry';
import { MarginCard } from './margin-card';
import { useMarginStore } from './margin-store';
import { makeComment, makeThread } from './test-helpers';

const CTX: MarginCardContext = {
  projectId: 'book-reinforcement-learning',
  nodeId: 'rl-sec-1-1',
  currentUserId: MOCK_USER.id,
  restoreEditorFocus: vi.fn(),
  applyServerContent: vi.fn(),
  hasUnsavedEdits: () => false,
  flushEdits: () => Promise.resolve(),
  holdSaving: () => Promise.resolve(() => {}),
  serverAnchor: toServerAnchor,
  editBlockedReason: null,
  revisable: true,
  rewriteBlock: null,
  knownIds: () => new Set<string>(),
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
  useMarginStore.setState({ drafts: {} });
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

  it('cancels a reply with Escape and returns focus to the Reply button', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Reply' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reply' })).toHaveFocus());
  });

  it('returns focus to the Reply button after a reply is sent', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Reply' }),
      'ok{Control>}{Enter}{/Control}',
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reply' })).toHaveFocus());
  });

  it('returns focus to the Edit button after an edit is saved', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole('button', { name: /^Edit comment by/ }));
    const box = screen.getByRole('textbox', { name: /^Edit comment by/ });
    expect((box as HTMLTextAreaElement).selectionStart).toBe(
      (box as HTMLTextAreaElement).value.length,
    );
    await user.type(box, '!{Control>}{Enter}{/Control}');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Edit comment by/ })).toHaveFocus(),
    );
  });

  it('keeps focus on the card after a reply is deleted, and on the Delete button after Escape in the dialog', async () => {
    const user = userEvent.setup();
    renderCard({ replies: [{ bodyMarkdown: 'my reply' }] });
    const card = screen.getByRole('region', { name: /^Comment by/ });
    const deletes = screen.getAllByRole('button', { name: /^Delete comment by/ });
    await user.click(deletes[1]!);
    await waitFor(() => expect(db.comments.has('reply-0')).toBe(false));
    await waitFor(() => expect(card).toHaveFocus());

    const rootDelete = screen.getAllByRole('button', { name: /^Delete comment by/ })[0]!;
    await user.click(rootDelete);
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(rootDelete).toHaveFocus());
  });

  it('sends focus back to the text when resolving hides the card, and when a thread is deleted', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(CTX.restoreEditorFocus).toHaveBeenCalled();
  });

  it('keeps an unsent reply when the card unmounts, and reopens on it', async () => {
    const user = userEvent.setup();
    const first = renderCard();
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await user.type(screen.getByRole('textbox', { name: 'Reply' }), 'half written');
    first.unmount();
    renderCard();
    expect(screen.getByRole('textbox', { name: 'Reply' })).toHaveValue('half written');
    // Cancelling is explicit: the text is dropped.
    await user.keyboard('{Escape}');
    expect(useMarginStore.getState().drafts).toEqual({});
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

  it('hands a reply that mentions @copilot to the context, and one that does not, still', async () => {
    const user = userEvent.setup();
    const onCommentSent = vi.fn();
    renderCard({ ctx: { onCommentSent } });
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await user.type(screen.getByRole('textbox', { name: 'Reply' }), '@copilot please check');
    // The button says what sending will do before it starts a model job.
    await user.click(screen.getByRole('button', { name: 'Reply and ask Copilot' }));
    await waitFor(() => expect(onCommentSent).toHaveBeenCalledTimes(1));
    expect(onCommentSent).toHaveBeenCalledWith(
      expect.objectContaining({ bodyMarkdown: '@copilot please check', parentId: 'root-1' }),
    );
  });

  it("offers no edit or delete on someone else's message", () => {
    renderCard({ ownRoot: false });
    expect(screen.queryByRole('button', { name: /^Edit comment/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete comment/ })).not.toBeInTheDocument();
  });

  it('shows Send to Copilot only when the context supplies its handler', async () => {
    const user = userEvent.setup();
    const first = renderCard();
    expect(screen.queryByRole('button', { name: 'Send to Copilot' })).not.toBeInTheDocument();
    first.unmount();
    const onSendToCopilot = vi.fn();
    renderCard({ ctx: { onSendToCopilot } });
    await user.click(screen.getByRole('button', { name: 'Send to Copilot' }));
    expect(onSendToCopilot).toHaveBeenCalledWith(expect.objectContaining({ id: 'root-1' }));
  });

  it('keeps the relative time ticking without a re-render from outside', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: Date.now() });
    try {
      renderCard();
      expect(screen.getByText('5 min ago')).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
      });
      expect(screen.getByText('10 min ago')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('disables Reply and Resolve while a thread is still being created', () => {
    renderCard({ root: { id: 'optimistic-1' } });
    expect(screen.getByRole('button', { name: 'Reply' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Edit comment by/ })).toBeDisabled();
  });

  it('confirms before deleting a root even without replies', async () => {
    const user = userEvent.setup();
    const { root } = renderCard();
    await user.click(screen.getByRole('button', { name: /^Delete comment by/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Delete this comment?');
    expect(db.comments.has(root.id)).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Delete comment' }));
    await waitFor(() => expect(db.comments.has(root.id)).toBe(false));
  });
});
