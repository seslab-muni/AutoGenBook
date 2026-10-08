import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client';
import { db } from '@/mocks/db';
import { useUiStore } from '@/stores/ui-store';
import { renderWithProviders } from '@/test/component-test-utils';

import { PromptDraftCard } from './prompt-window';
import { buildRevisionRequest, countSentences, threadsInScope } from './prompt-request';
import { draftKey, noChips, useMarginStore, type ComposerDraft } from './margin-store';
import { makeComment, makeContext, makeReview, makeThread } from './test-helpers';
import type { MarginCardContext } from './card-registry';
import type { MarginThread } from './threads';

const ANCHOR = {
  quote: 'Because a finite MDP has only finitely many policies. It terminates.',
  prefix: '',
  suffix: '',
  start: 10,
  end: 78,
};

function problem(status: number, code: string, detail = 'server words') {
  return new ApiError({
    status,
    url: '/x',
    problem: { type: 'about:blank', title: 'Conflict', status, instance: '/x', detail, code },
  });
}

function Host({
  ctx,
  threads,
  range,
  quote,
}: {
  ctx: MarginCardContext;
  threads: MarginThread[];
  range: { start: number; end: number } | null;
  quote: string | null;
}) {
  const composer = useMarginStore((state) => state.composer);
  if (!composer) return <p>closed</p>;
  return (
    <PromptDraftCard
      draft={composer}
      ctx={ctx}
      top={0}
      register={() => {}}
      quote={quote}
      threads={threads}
      range={range}
    />
  );
}

function open(
  options: {
    anchor?: typeof ANCHOR | null;
    ctx?: Partial<MarginCardContext>;
    threads?: MarginThread[];
    draft?: Partial<Extract<ComposerDraft, { kind: 'prompt' }>>;
    text?: string;
    range?: { start: number; end: number } | null;
  } = {},
) {
  const startRevision = vi.fn<NonNullable<MarginCardContext['startRevision']>>(() =>
    Promise.resolve({ kind: 'suggestion' } as never),
  );
  const ctx = makeContext({ startRevision, ...options.ctx });
  const anchor = options.anchor === undefined ? null : options.anchor;
  const element = (
    <Host
      ctx={ctx}
      threads={options.threads ?? []}
      range={options.range ?? (anchor ? { start: 10, end: 78 } : null)}
      quote={anchor ? anchor.quote : null}
    />
  );
  const view = renderWithProviders(element);
  act(() =>
    useMarginStore.getState().openPrompt(
      {
        kind: 'prompt',
        anchor,
        verb: 'revise',
        chips: noChips(),
        origin: 'selection',
        replaces: null,
        threadId: null,
        ...options.draft,
      },
      ctx.nodeId,
      options.text ?? '',
    ),
  );
  return { ctx, startRevision, view, element };
}

beforeEach(() => {
  useMarginStore.setState({ composer: null, drafts: {} });
});

describe('prompt window', () => {
  it('names a selection scope by its sentences and locks the request to the range', async () => {
    const user = userEvent.setup();
    const { startRevision } = open({ anchor: ANCHOR });
    expect(screen.getByText('Selection · 2 sentences')).toBeInTheDocument();
    expect(screen.getByText(ANCHOR.quote)).toBeInTheDocument();
    await user.type(
      screen.getByRole('textbox', { name: 'Instruction for the copilot' }),
      'add a proof',
    );
    await user.click(screen.getByRole('button', { name: 'Revise' }));
    expect(startRevision).toHaveBeenCalledWith(
      {
        verb: 'revise',
        scope: 'range',
        anchor: ANCHOR,
        instruction: 'add a proof',
        params: expect.objectContaining({ moreProofs: false, fixIssueIds: [] }),
      },
      { moveFocus: true },
    );
  });

  it('names a section scope by its number', () => {
    open({ anchor: null, ctx: { sectionNumber: '2.3' } });
    expect(screen.getByText('Section §2.3')).toBeInTheDocument();
    expect(screen.queryByText(ANCHOR.quote)).not.toBeInTheDocument();
  });

  it('puts focus in the instruction box on open', async () => {
    open();
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Instruction for the copilot' })).toHaveFocus(),
    );
  });

  it('sends with Ctrl+Enter, from the box and from a chip, and closes on success', async () => {
    const user = userEvent.setup();
    const { startRevision } = open();
    await user.type(
      screen.getByRole('textbox', { name: 'Instruction for the copilot' }),
      'shorter',
    );
    await user.click(screen.getByRole('button', { name: 'more proofs' }));
    // Focus is on the chip now: Ctrl+Enter still sends.
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(startRevision).toHaveBeenCalledTimes(1);
    expect(startRevision.mock.calls[0]![0]).toMatchObject({
      verb: 'revise',
      scope: 'section',
      instruction: 'shorter',
      params: { moreProofs: true },
    });
    await waitFor(() => expect(screen.getByText('closed')).toBeInTheDocument());
    // The sent text is gone for good.
    expect(useMarginStore.getState().drafts[draftKey('rl-sec-1-1', 'prompt')]).toBeUndefined();
  });

  it('closes on Escape from anywhere in the window and forgets the text', async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByRole('textbox', { name: 'Instruction for the copilot' }), 'draft');
    await user.click(screen.getByRole('button', { name: 'longer' }));
    await user.keyboard('{Escape}');
    expect(screen.getByText('closed')).toBeInTheDocument();
    expect(useMarginStore.getState().drafts[draftKey('rl-sec-1-1', 'prompt')]).toBeUndefined();
  });

  it('cannot send nothing: a blank instruction with no chip is disabled, a chip alone is enough', async () => {
    const user = userEvent.setup();
    open();
    expect(screen.getByRole('button', { name: 'Revise' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'cite sources' }));
    expect(screen.getByRole('button', { name: 'Revise' })).toBeEnabled();
  });

  it('toggles the chips as typed fields; shorter and longer exclude each other', async () => {
    const user = userEvent.setup();
    const { startRevision } = open();
    const pressed = (name: string) =>
      screen.getByRole('button', { name }).getAttribute('aria-pressed') === 'true';
    await user.click(screen.getByRole('button', { name: 'shorter' }));
    expect(pressed('shorter')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'longer' }));
    expect(pressed('longer')).toBe(true);
    expect(pressed('shorter')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'longer' }));
    expect(pressed('longer')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'longer' }));
    for (const name of ['more proofs', 'more examples', 'more rigorous', 'cite sources']) {
      await user.click(screen.getByRole('button', { name }));
    }
    await user.click(screen.getByRole('button', { name: 'Revise' }));
    expect(startRevision.mock.calls[0]![0]).toMatchObject({
      instruction: '',
      params: {
        moreProofs: true,
        moreExamples: true,
        moreRigorous: true,
        shorter: false,
        longer: true,
        citeSources: true,
      },
    });
  });

  it('counts the open review issues and comments in scope, and sends their ids', async () => {
    const user = userEvent.setup();
    const inside = makeThread(makeReview({ id: 'issue-in' }), { range: { start: 20, end: 40 } });
    const outside = makeThread(makeReview({ id: 'issue-out' }), {
      range: { start: 200, end: 220 },
    });
    const dismissed = makeThread(makeReview({ id: 'issue-done', status: 'resolved' }), {
      range: { start: 20, end: 40 },
    });
    const comment = makeThread(makeComment({ id: 'comment-in' }), {
      range: { start: 30, end: 35 },
    });
    const { startRevision } = open({
      anchor: ANCHOR,
      threads: [inside, outside, dismissed, comment],
    });
    // Selection scope: only what overlaps the selection.
    await user.click(screen.getByRole('button', { name: 'fix 1 issue' }));
    await user.click(screen.getByRole('button', { name: 'address 1 comment' }));
    await user.click(screen.getByRole('button', { name: 'Revise' }));
    expect(startRevision.mock.calls[0]![0]).toMatchObject({
      params: { fixIssueIds: ['issue-in'], addressCommentIds: ['comment-in'] },
    });
  });

  it('counts every open card for the whole section, and disables a chip with nothing behind it', () => {
    open({
      anchor: null,
      threads: [
        makeThread(makeReview({ id: 'a' }), { range: { start: 20, end: 40 } }),
        makeThread(makeReview({ id: 'b' }), { range: { start: 200, end: 220 } }),
        makeThread(makeReview({ id: 'c', anchor: null })),
      ],
    });
    expect(screen.getByRole('button', { name: 'fix 3 issues' })).not.toHaveAttribute(
      'aria-disabled',
    );
    expect(screen.getByRole('button', { name: 'address 0 comments' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('Rewrite sends only the instruction, and is unavailable for a range, a thread or with options on', async () => {
    const user = userEvent.setup();
    const section = open({ anchor: null });
    await user.type(
      screen.getByRole('textbox', { name: 'Instruction for the copilot' }),
      'start over',
    );
    await user.click(screen.getByRole('radio', { name: 'Rewrite' }));
    expect(screen.getByRole('radio', { name: 'Rewrite' })).toBeChecked();
    // The options are locked while rewriting.
    expect(screen.getByRole('button', { name: 'more proofs' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Rewrite' }));
    expect(section.startRevision).toHaveBeenCalledWith(
      { verb: 'rewrite', instruction: 'start over' },
      { moveFocus: true },
    );
  });

  it.each([
    ['a range', { anchor: ANCHOR }, /cannot be limited to a selection/],
    ['a thread', { anchor: null, draft: { threadId: 't1' } }, /cannot answer a comment thread/],
  ])('refuses Rewrite for %s with the reason', async (_name, options, reason) => {
    const user = userEvent.setup();
    open(options as Parameters<typeof open>[0]);
    const rewrite = screen.getByRole('radio', { name: 'Rewrite' });
    expect(rewrite).toHaveAttribute('aria-disabled', 'true');
    expect(rewrite.getAttribute('title')).toMatch(reason);
    await user.click(rewrite);
    expect(screen.getByRole('radio', { name: 'Revise' })).toBeChecked();
  });

  it('refuses Rewrite while an option is on', async () => {
    const user = userEvent.setup();
    open({ anchor: null });
    await user.click(screen.getByRole('button', { name: 'more proofs' }));
    const rewrite = screen.getByRole('radio', { name: 'Rewrite' });
    expect(rewrite).toHaveAttribute('aria-disabled', 'true');
    await user.click(rewrite);
    expect(screen.getByRole('radio', { name: 'Revise' })).toBeChecked();
  });

  it('keeps unsent text, options and verb across the card unmounting (a side sheet closing)', async () => {
    const user = userEvent.setup();
    const first = open({ anchor: null });
    await user.type(
      screen.getByRole('textbox', { name: 'Instruction for the copilot' }),
      'half writ',
    );
    await user.click(screen.getByRole('button', { name: 'cite sources' }));
    first.view.unmount();
    expect(useMarginStore.getState().drafts[draftKey('rl-sec-1-1', 'prompt')]).toBe('half writ');

    // The same composer, a fresh mount: everything is back.
    renderWithProviders(first.element);
    expect(screen.getByRole('textbox', { name: 'Instruction for the copilot' })).toHaveValue(
      'half writ',
    );
    expect(screen.getByRole('button', { name: 'cite sources' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('restores the text when the window is mounted again', () => {
    const { ctx } = open({ text: 'carried over' });
    expect(screen.getByRole('textbox', { name: 'Instruction for the copilot' })).toHaveValue(
      'carried over',
    );
    expect(ctx.nodeId).toBe('rl-sec-1-1');
  });

  it("a fresh window does not inherit the previous one's text", () => {
    useMarginStore.getState().setDraftText(draftKey('rl-sec-1-1', 'prompt'), 'stale');
    open({ text: '' });
    expect(screen.getByRole('textbox', { name: 'Instruction for the copilot' })).toHaveValue('');
  });

  it('prefills a Try again with the instruction and options, and rejects the old suggestion once the new one starts', async () => {
    const user = userEvent.setup();
    const old = makeComment({ id: 'old-s', kind: 'suggestion', status: 'pending' });
    db.comments.set(old.id, { ...old, authorId: 'user-mock-1' });
    const { startRevision } = open({
      anchor: null,
      text: 'prove it',
      draft: {
        chips: { ...noChips(), moreProofs: true, length: 'longer' },
        replaces: { id: 'old-s', status: 'pending' },
        threadId: 'thread-9',
        origin: 'retry',
      },
    });
    expect(screen.getByRole('textbox', { name: 'Instruction for the copilot' })).toHaveValue(
      'prove it',
    );
    expect(screen.getByRole('button', { name: 'more proofs' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'longer' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Revise' }));
    expect(startRevision.mock.calls[0]![0]).toMatchObject({
      threadId: 'thread-9',
      instruction: 'prove it',
      params: { moreProofs: true, longer: true },
    });
    await waitFor(() => expect(db.comments.get('old-s')?.status).toBe('rejected'));
  });

  it.each([
    ['section_empty', 409, /nothing to revise/i],
    ['node_generating', 409, /run is generating/i],
    ['anchor_orphaned', 409, /select it again/i],
    ['revision_in_progress', 409, /already running/i],
    ['llm_key_required', 409, /API key/],
    ['llm_not_configured', 409, /No LLM key/],
    ['too_many_revisions', 429, /several revisions running/],
    ['section_too_large', 409, /select a passage/i],
  ])('shows the %s refusal inline, keeps the text and stays open', async (code, status, words) => {
    const user = userEvent.setup();
    const { startRevision } = open({ text: 'my careful instruction' });
    startRevision.mockRejectedValueOnce(problem(status, code));
    await user.click(screen.getByRole('button', { name: 'Revise' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(words);
    expect(alert).not.toHaveTextContent(String(status));
    expect(screen.getByRole('textbox', { name: 'Instruction for the copilot' })).toHaveValue(
      'my careful instruction',
    );
    expect(screen.getByRole('button', { name: 'Revise' })).toBeEnabled();
  });

  it('offers the account dialog when a key is needed, and a hint when the section is too large', async () => {
    const user = userEvent.setup();
    useUiStore.setState({ activeModal: null });
    const { startRevision } = open({ text: 'x' });
    startRevision.mockRejectedValueOnce(problem(409, 'llm_key_required'));
    await user.click(screen.getByRole('button', { name: 'Revise' }));
    await user.click(await screen.findByRole('button', { name: 'Account settings' }));
    expect(useUiStore.getState().activeModal).toBe('account');
  });

  it("shows a rewrite refusal in the server's own words", async () => {
    const user = userEvent.setup();
    const { startRevision } = open({ text: 'again' });
    await user.click(screen.getByRole('radio', { name: 'Rewrite' }));
    startRevision.mockRejectedValueOnce(
      problem(409, 'no_base_run', 'No successful prior run to resume from'),
    );
    await user.click(screen.getByRole('button', { name: 'Rewrite' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No successful prior run to resume from',
    );
  });

  it('ignores a second send while one is in flight', async () => {
    const user = userEvent.setup();
    let resolve!: (value: never) => void;
    const { startRevision } = open({ text: 'go' });
    startRevision.mockImplementationOnce(() => new Promise((r) => (resolve = r as never)));
    await user.click(screen.getByRole('button', { name: 'Revise' }));
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(startRevision).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    await act(async () => resolve({ kind: 'suggestion' } as never));
  });
});

describe('prompt request helpers', () => {
  it('counts sentences, at least one', () => {
    expect(countSentences('One.')).toBe(1);
    expect(countSentences('One. Two! Three?  ')).toBe(3);
    expect(countSentences('no punctuation at all')).toBe(1);
    expect(countSentences('')).toBe(1);
  });

  it('builds a revise request with every chip as a typed field, ids capped at 25', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `i${i}`);
    const request = buildRevisionRequest({
      verb: 'revise',
      anchor: null,
      instruction: 'x',
      chips: { ...noChips(), length: 'shorter', fixIssues: true },
      fixIssueIds: ids,
      addressCommentIds: ['c'],
    });
    expect(request).toMatchObject({ verb: 'revise', scope: 'section', instruction: 'x' });
    expect('anchor' in request).toBe(false);
    expect(request.params?.shorter).toBe(true);
    expect(request.params?.longer).toBe(false);
    expect(request.params?.fixIssueIds).toHaveLength(25);
    // A chip that is off sends no ids even when some are in scope.
    expect(request.params?.addressCommentIds).toEqual([]);
  });

  it('builds a rewrite as the instruction alone', () => {
    expect(
      buildRevisionRequest({
        verb: 'rewrite',
        anchor: null,
        instruction: 'again',
        chips: { ...noChips(), moreProofs: true },
        fixIssueIds: [],
        addressCommentIds: [],
      }),
    ).toEqual({ verb: 'rewrite', instruction: 'again' });
  });

  it('finds the open threads of a kind inside a range', () => {
    const open1 = makeThread(makeReview({ id: 'a', status: 'orphaned' }), { range: null });
    const inRange = makeThread(makeReview({ id: 'b' }), { range: { start: 5, end: 9 } });
    expect(threadsInScope([open1, inRange], 'review', null, true).map((t) => t.id)).toEqual([
      'a',
      'b',
    ]);
    expect(
      threadsInScope([open1, inRange], 'review', { start: 8, end: 20 }, false).map((t) => t.id),
    ).toEqual(['b']);
    expect(threadsInScope([open1, inRange], 'review', { start: 9, end: 20 }, false)).toEqual([]);
    expect(threadsInScope([inRange], 'comment', null, true)).toEqual([]);
  });
});
