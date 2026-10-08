import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { projectKeys } from '@/api/queries/keys';
import type { Comment, OutlineNode } from '@/api/types';
import { TooltipProvider } from '@/components/ui/tooltip';
import { fakeRevise } from '@/mocks/fakeRevise';
import { db } from '@/mocks/db';
import { server } from '@/mocks/server';
import { sha256Hex } from '@/lib/content-hash';

import type { MarginCardContext } from './card-registry';
import { MarginCard } from './margin-card';
import { useMarginStore } from './margin-store';
import { useSuggestionProgress } from './suggestion-progress';
import { makeComment, makeContext, makeSuggestion, makeThread } from './test-helpers';

const toasts = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  message: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: toasts }));

const PROJECT = 'book-reinforcement-learning';
const NODE = 'rl-sec-1-1';

function nodeRow() {
  return db.outlineNodes.get(NODE)!;
}

/** A suggestion row as the API stores it for the real text of the section. */
async function pendingSuggestion(
  options: {
    scope?: 'section' | 'range';
    params?: Record<string, unknown>;
    instruction?: string;
    overrides?: Partial<Comment>;
  } = {},
) {
  const original = nodeRow().contentMarkdown;
  const scope = options.scope ?? 'section';
  const range =
    scope === 'range'
      ? (() => {
          const start = original.indexOf('Because a finite');
          return { start, end: start + 60 };
        })()
      : null;
  const params = {
    moreProofs: false,
    moreExamples: false,
    moreRigorous: false,
    shorter: false,
    longer: false,
    citeSources: false,
    fixIssueIds: [] as string[],
    addressCommentIds: [] as string[],
    ...options.params,
  };
  const revision = fakeRevise(original, range, {
    instruction: options.instruction ?? 'Add a proof.',
    params,
  });
  const row = makeSuggestion(
    {
      status: 'pending',
      bodyMarkdown: revision.summary,
      anchor: range
        ? {
            quote: original.slice(range.start, range.end),
            prefix: '',
            suffix: '',
            start: range.start,
            end: range.end,
          }
        : null,
      ...options.overrides,
    },
    {
      scope,
      instruction: options.instruction ?? 'Add a proof.',
      params,
      baseContentHash: await sha256Hex(original),
      originalMarkdown: original,
      replacementMarkdown: revision.replacement,
      hunks: revision.hunks,
      summary: revision.summary,
      changesMade: revision.changesMade,
      warnings: revision.warnings,
      droppedCitations: revision.droppedCitations,
    },
  );
  db.comments.set(row.id, row);
  return { row, revision, original };
}

interface Harness {
  ctx: MarginCardContext;
  queryClient: QueryClient;
  calls: string[];
}

function renderSuggestion(
  row: Comment,
  options: {
    ctx?: Partial<MarginCardContext>;
    orphaned?: boolean;
    replies?: Comment[];
    root?: Comment;
  } = {},
): Harness {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const node = nodeRow();
  queryClient.setQueryData<OutlineNode>(projectKeys.outlineNode(PROJECT, NODE), {
    ...node,
    contentHash: null,
  });
  const calls: string[] = [];
  const ctx = makeContext({
    holdSaving: () => {
      calls.push('hold');
      return Promise.resolve(() => calls.push('release'));
    },
    applyServerContent: vi.fn(() => calls.push('apply')),
    ...options.ctx,
  });
  const root = options.root ?? row;
  const thread = {
    ...makeThread(root, {
      replies: options.replies ?? [],
      range: row.anchor && !options.orphaned ? { start: 0, end: 10 } : null,
    }),
    ...(options.orphaned ? { orphaned: true } : {}),
  };
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MarginCard
          thread={thread}
          ctx={ctx}
          register={() => {}}
          top={0}
          focused={false}
          onFocusCard={vi.fn()}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ctx, queryClient, calls };
}

/** Requests the mock API receives, in order, as `METHOD path`. */
function recordRequests(into: string[]) {
  const listener = ({ request }: { request: Request }) => {
    if (request.method !== 'GET') into.push(`${request.method} ${new URL(request.url).pathname}`);
  };
  server.events.on('request:start', listener);
  return () => server.events.removeListener('request:start', listener);
}

beforeEach(() => {
  vi.clearAllMocks();
  useMarginStore.setState({ drafts: {}, focusedId: null });
  useSuggestionProgress.setState({ events: {} });
});

describe('suggestion card: working', () => {
  it('shows who is working, the elapsed time and the live stage line from the progress events', async () => {
    const row = makeSuggestion();
    db.comments.set(row.id, row);
    renderSuggestion(row);
    const card = screen.getByRole('region', { name: /^Suggestion by Ada Researcher/ });
    expect(within(card).getByText(/Working/)).toBeInTheDocument();
    expect(within(card).getByText('“Add a short proof.”')).toBeInTheDocument();
    expect(within(card).getByText('Starting…')).toBeInTheDocument();

    act(() => {
      useSuggestionProgress.getState().append(row.id, {
        seq: 1,
        ts: '',
        stage: 'retrieve',
        level: 'info',
        message: 'x',
        payload: { phase: 'done' },
      });
      useSuggestionProgress.getState().append(row.id, {
        seq: 2,
        ts: '',
        stage: 'revise',
        level: 'info',
        message: 'y',
        payload: { phase: 'start' },
      });
    });
    expect(within(card).getByText('Revising the text…')).toBeInTheDocument();
    const steps = within(card).getByRole('list', { name: 'Progress' });
    expect(within(steps).getByText('Retrieve').closest('li')).toHaveTextContent('(done)');
    expect(within(steps).getByText('Revise').closest('li')).toHaveAttribute('aria-current', 'step');
    // The running -> pending change is announced politely, once, by a live region.
    expect(within(card).getByRole('status')).toHaveTextContent(
      'The copilot is working on a suggestion.',
    );
  });

  it('lets only its author cancel it, through the cancel endpoint', async () => {
    const user = userEvent.setup();
    const mine = makeSuggestion();
    db.comments.set(mine.id, mine);
    const first = renderSuggestion(mine);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(db.comments.get(mine.id)?.status).toBe('cancelled'));
    expect(first.calls).toEqual([]);
  });

  it("offers no Cancel on someone else's revision", () => {
    const theirs = makeSuggestion({ authorId: 'u-2', authorName: 'Grace' });
    db.comments.set(theirs.id, theirs);
    renderSuggestion(theirs);
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.getByText('Started by Grace')).toBeInTheDocument();
  });
});

describe('suggestion card: ready to review', () => {
  it('shows the diff of a section revision, one group per change, with the summary and notes', async () => {
    const { row, revision } = await pendingSuggestion({
      params: { moreProofs: true, moreExamples: true, citeSources: true },
    });
    renderSuggestion(row);
    const card = screen.getByRole('region', { name: /^Suggestion/ });
    expect(within(card).getByText('Ready to review')).toBeInTheDocument();
    const groups = within(card).getAllByRole('group', { name: /^Change \d+ of \d+$/ });
    // Three changes fit the collapsed view: a reworded word and two insertions.
    expect(groups).toHaveLength(revision.hunks.length);
    // Removed text is struck (a <del>), added text underlined (an <ins>), and both are announced.
    const removed = card.querySelector('del');
    expect(removed).toHaveTextContent('Removed: guarantees');
    expect(card.querySelector('ins')).toHaveTextContent('Added: ensures');
    // The summary, a warning and the dropped citation are compact, not hidden.
    expect(within(card).getByLabelText('Warnings')).toHaveTextContent(
      'Only sources of the last run',
    );
    expect(within(card).getByText(/Removed unknown citations: unknownKey2099/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Accept' })).toBeEnabled();
    expect(within(card).getByRole('button', { name: 'Reject' })).toBeEnabled();
  });

  it('collapses changes beyond the first few behind "Show all N changes"', async () => {
    const user = userEvent.setup();
    const { row } = await pendingSuggestion({ params: { moreProofs: true } });
    const hunks = (row.payload as { hunks: unknown[] }).hunks;
    // Four more small edits in the stored payload: six changes.
    const original = (row.payload as { originalMarkdown: string }).originalMarkdown;
    const extra = ['policy', 'state', 'optimal', 'finite'].map((word) => {
      const start = original.lastIndexOf(word);
      return { start, end: start + word.length, removed: word, added: word.toUpperCase() };
    });
    const withMany = {
      ...row,
      payload: {
        ...row.payload,
        hunks: [...hunks, ...extra].sort(
          (a, b) => (a as { start: number }).start - (b as { start: number }).start,
        ),
      },
    } as Comment;
    renderSuggestion(withMany);
    const total = (withMany.payload as { hunks: unknown[] }).hunks.length;
    expect(screen.getAllByRole('group', { name: /^Change \d+ of / })).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: `Show all ${total} changes` }));
    expect(screen.getAllByRole('group', { name: /^Change \d+ of / })).toHaveLength(total);
    await user.click(screen.getByRole('button', { name: 'Show fewer changes' }));
    expect(screen.getAllByRole('group', { name: /^Change \d+ of / })).toHaveLength(3);
  });

  it("shows the range's before/after for a range suggestion, with no per-change checkboxes", async () => {
    const { row } = await pendingSuggestion({
      scope: 'range',
      params: { moreProofs: true },
      overrides: {},
    });
    renderSuggestion(row);
    const card = screen.getByRole('region', { name: /^Suggestion/ });
    expect(card.querySelector('ins')).toHaveTextContent(/Proof sketch/);
    expect(within(card).queryByRole('checkbox')).not.toBeInTheDocument();
    // Only the selected range is shown as context, not the rest of the section.
    expect(card).not.toHaveTextContent('Policy Iteration');
  });

  it('says nothing was changed, and offers no Accept, when the model handed the text back', async () => {
    const { row } = await pendingSuggestion({ params: {} });
    renderSuggestion({
      ...row,
      payload: {
        ...row.payload,
        hunks: [],
        replacementMarkdown: (row.payload as { originalMarkdown: string }).originalMarkdown,
      },
    } as Comment);
    expect(screen.getByText(/found nothing to change/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });

  it('warns that the text changed under a range suggestion whose anchor is orphaned, and still offers Accept and Try again', async () => {
    const { row } = await pendingSuggestion({ scope: 'range', params: { moreProofs: true } });
    renderSuggestion(row, { orphaned: true });
    expect(screen.getByText(/The text changed since this was suggested/)).toBeInTheDocument();
    expect(screen.getByText('Orphaned')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('Reject sends the reject request and keeps the keyboard in the text', async () => {
    const user = userEvent.setup();
    const { row } = await pendingSuggestion({ params: { moreProofs: true } });
    const { ctx } = renderSuggestion(row);
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(db.comments.get(row.id)?.status).toBe('rejected'));
    expect(ctx.restoreEditorFocus).toHaveBeenCalled();
  });

  it('Try again > Edit the instruction hands the suggestion to the prompt window', async () => {
    const user = userEvent.setup();
    const { row } = await pendingSuggestion({ params: { moreProofs: true } });
    const onTryAgain = vi.fn();
    renderSuggestion(row, { ctx: { onTryAgain } });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit the instruction…' }));
    expect(onTryAgain).toHaveBeenCalledWith(
      expect.objectContaining({ id: row.id }),
      expect.anything(),
    );
  });

  it('Try again > Ask again as it was starts the same request and rejects the old suggestion', async () => {
    const user = userEvent.setup();
    const { row } = await pendingSuggestion({
      params: { moreProofs: true },
      instruction: 'Prove it.',
    });
    const startRevision = vi.fn(() => Promise.resolve({ kind: 'suggestion' } as never));
    renderSuggestion(row, { ctx: { startRevision } });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Ask again as it was' }));
    expect(startRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        verb: 'revise',
        scope: 'section',
        instruction: 'Prove it.',
        params: expect.objectContaining({ moreProofs: true }),
      }),
    );
    await waitFor(() => expect(db.comments.get(row.id)?.status).toBe('rejected'));
  });
});

describe('suggestion card: accept', () => {
  it('saves and holds autosave, then accepts, then adopts the returned text, then lets go - in that order', async () => {
    const user = userEvent.setup();
    const { row, revision } = await pendingSuggestion({ params: { moreProofs: true } });
    const { ctx, calls } = renderSuggestion(row);
    // Requests go into the same log as the hold, the adoption and the release.
    const stop = recordRequests(calls);
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(calls).toContain('release'));
    stop();

    expect(calls).toEqual([
      'hold',
      `POST /api/v1/suggestions/${row.id}/accept`,
      'apply',
      'release',
    ]);
    expect(db.comments.get(row.id)?.status).toBe('accepted');
    expect(nodeRow().contentMarkdown).toBe(revision.replacement);
    expect(ctx.applyServerContent).toHaveBeenCalledWith(revision.replacement);
    expect(ctx.restoreEditorFocus).toHaveBeenCalled();
  });

  it('sends expectedContentHash: the hash of the text the section held', async () => {
    const user = userEvent.setup();
    const { row } = await pendingSuggestion({ params: { moreProofs: true } });
    let body: { expectedContentHash?: string; hunkIndexes?: number[] } | undefined;
    server.use(
      http.post('*/api/v1/suggestions/:id/accept', async ({ request }) => {
        body = (await request.json()) as typeof body;
        return HttpResponse.json(
          { type: 'about:blank', title: 'x', status: 409, instance: '/x', code: 'stale' },
          { status: 409 },
        );
      }),
    );
    renderSuggestion(row);
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await screen.findByRole('alert');
    expect(body?.expectedContentHash).toBe(await sha256Hex(nodeRow().contentMarkdown));
    expect(body?.hunkIndexes).toBeUndefined();
  });

  it('accepts only the ticked changes of a section revision, as hunkIndexes', async () => {
    const user = userEvent.setup();
    const { row, revision } = await pendingSuggestion({
      params: { moreProofs: true, moreExamples: true },
    });
    expect(revision.hunks.length).toBeGreaterThanOrEqual(3);
    let body: { hunkIndexes?: number[] } | undefined;
    server.events.on('request:start', async ({ request }) => {
      if (request.url.includes('/accept')) body = (await request.clone().json()) as typeof body;
    });
    const { ctx } = renderSuggestion(row);
    await user.click(screen.getByRole('checkbox', { name: 'Apply change 2 of 3' }));
    expect(screen.getByRole('button', { name: 'Accept 2 of 3' })).toBeInTheDocument();
    // Nothing is linked to this request, so there is nothing to warn about.
    expect(
      screen.queryByText(/leaves the linked comments and issues open/),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept 2 of 3' }));
    await waitFor(() => expect(db.comments.get(row.id)?.status).toBe('accepted'));
    await waitFor(() => expect(body?.hunkIndexes).toEqual([0, 2]));
    const applied = (ctx.applyServerContent as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(applied).not.toBe(revision.replacement);
    expect(applied).toContain(revision.hunks[0]!.added);
    expect(applied).not.toContain(revision.hunks[1]!.added);
  });

  it('warns that a partial accept leaves the linked comments and issues open', async () => {
    const user = userEvent.setup();
    const { row } = await pendingSuggestion({
      params: { moreProofs: true, moreExamples: true, fixIssueIds: ['issue-1'] },
    });
    renderSuggestion(row);
    expect(
      screen.queryByText(/leaves the linked comments and issues open/),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Apply change 2 of 3' }));
    expect(screen.getByText(/leaves the linked comments and issues open/)).toBeInTheDocument();
  });

  it('cannot accept with every change unticked', async () => {
    const user = userEvent.setup();
    const { row } = await pendingSuggestion({ params: { moreProofs: true, moreExamples: true } });
    renderSuggestion(row);
    for (const name of ['Apply change 1 of 3', 'Apply change 2 of 3', 'Apply change 3 of 3']) {
      await user.click(screen.getByRole('checkbox', { name }));
    }
    expect(screen.getByRole('button', { name: 'Accept 0 of 3' })).toBeDisabled();
  });

  it('explains a stale suggestion inline, leaves the draft untouched and lets go of the hold', async () => {
    const user = userEvent.setup();
    const { row } = await pendingSuggestion({ params: { moreProofs: true } });
    // The section's text changed since the suggestion was made, around its first change.
    const node = nodeRow();
    db.outlineNodes.set(NODE, {
      ...node,
      contentMarkdown: node.contentMarkdown.replace('guarantees', 'ensures'),
    });
    const { ctx, calls, queryClient } = renderSuggestion(row);
    // The client still shows the old text and hash: no content_conflict, the server decides it is stale.
    queryClient.setQueryData<OutlineNode>(projectKeys.outlineNode(PROJECT, NODE), {
      ...node,
      contentHash: await sha256Hex(nodeRow().contentMarkdown),
    });
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/can no longer be applied cleanly/);
    expect(ctx.applyServerContent).not.toHaveBeenCalled();
    expect(calls).toEqual(['hold', 'release']);
    expect(toasts.error).not.toHaveBeenCalled();
    expect(db.comments.get(row.id)?.status).toBe('pending');
  });

  it('explains a content conflict inline too', async () => {
    const user = userEvent.setup();
    const { row } = await pendingSuggestion({ params: { moreProofs: true } });
    const { ctx, calls } = renderSuggestion(row);
    // Someone saved a different text after this client last saw the section.
    const node = nodeRow();
    db.outlineNodes.set(NODE, {
      ...node,
      contentMarkdown: `${node.contentMarkdown}\n\nEdited elsewhere.`,
    });
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/section changed since you last saw it/);
    expect(ctx.applyServerContent).not.toHaveBeenCalled();
    expect(calls).toEqual(['hold', 'release']);
  });

  it('does not ask the server anything when the pending edits cannot be saved first', async () => {
    const user = userEvent.setup();
    const { row } = await pendingSuggestion({ params: { moreProofs: true } });
    const requests: string[] = [];
    const stop = recordRequests(requests);
    const { ctx } = renderSuggestion(row, {
      ctx: { holdSaving: () => Promise.reject(new Error('Saving failed.')) },
    });
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    const alert = await screen.findByRole('alert');
    stop();
    expect(alert).toHaveTextContent(/could not be saved first, so nothing was applied/);
    expect(requests).toEqual([]);
    expect(ctx.applyServerContent).not.toHaveBeenCalled();
  });

  it('keeps a draft the user typed during the accept: the section notice decides, nothing is adopted over it', async () => {
    const user = userEvent.setup();
    const { row } = await pendingSuggestion({ params: { moreProofs: true } });
    const { ctx } = renderSuggestion(row, { ctx: { hasUnsavedEdits: () => true } });
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(db.comments.get(row.id)?.status).toBe('accepted'));
    expect(ctx.applyServerContent).not.toHaveBeenCalled();
  });

  it('offers an Undo that writes the previous text back, guarded by the hash the accept returned', async () => {
    const user = userEvent.setup();
    const { row, revision, original } = await pendingSuggestion({ params: { moreProofs: true } });
    const { ctx, calls } = renderSuggestion(row);
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith('Suggestion applied', expect.anything()),
    );
    const options = toasts.success.mock.calls[0]![1] as {
      action: { label: string; onClick: () => void };
    };
    expect(options.action.label).toBe('Undo');
    expect(nodeRow().contentMarkdown).toBe(revision.replacement);

    const patches: { contentMarkdown?: string; expectedContentHash?: string }[] = [];
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'PATCH')
        patches.push((await request.clone().json()) as (typeof patches)[number]);
    });
    act(() => options.action.onClick());
    await waitFor(() => expect(nodeRow().contentMarkdown).toBe(original));
    expect(patches[0]?.expectedContentHash).toBe(await sha256Hex(revision.replacement));
    expect(patches[0]?.contentMarkdown).toBe(original);
    await waitFor(() => expect(ctx.applyServerContent).toHaveBeenLastCalledWith(original));
    expect(calls.filter((call) => call === 'hold')).toHaveLength(2);
    expect(toasts.success).toHaveBeenCalledWith('Suggestion undone');
  });

  it('leaves the section alone and says why when the text was edited after the accept', async () => {
    const user = userEvent.setup();
    const { row, revision } = await pendingSuggestion({ params: { moreProofs: true } });
    renderSuggestion(row);
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    const options = toasts.success.mock.calls[0]![1] as { action: { onClick: () => void } };
    const node = nodeRow();
    db.outlineNodes.set(NODE, { ...node, contentMarkdown: `${node.contentMarkdown} Later edit.` });
    act(() => options.action.onClick());
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(String(toasts.error.mock.calls[0]![0])).toMatch(
      /edited after the suggestion was applied/,
    );
    expect(nodeRow().contentMarkdown).toBe(`${revision.replacement} Later edit.`);
  });
});

describe('suggestion card: finished', () => {
  it("maps a failed suggestion's error code to words and offers Try again and Dismiss", async () => {
    const user = userEvent.setup();
    const row = makeSuggestion(
      { status: 'failed' },
      { error: { code: 'llm_rate_limited', message: 'raw' } },
    );
    db.comments.set(row.id, row);
    const { ctx } = renderSuggestion(row);
    const card = screen.getByRole('region', { name: /^Suggestion/ });
    expect(within(card).getByText('Failed')).toBeInTheDocument();
    expect(within(card).getByText(/rate limiting requests/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(db.comments.has(row.id)).toBe(false));
    expect(ctx.restoreEditorFocus).toHaveBeenCalled();
  });

  it('shows a cancelled suggestion with Try again and Dismiss', () => {
    const row = makeSuggestion({ status: 'cancelled' });
    db.comments.set(row.id, row);
    renderSuggestion(row);
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText(/You stopped this revision/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it.each([
    ['accepted', 'The changes were applied.'],
    ['rejected', 'These changes were not applied.'],
  ] as const)('shows an %s suggestion compactly, with no actions', (status, text) => {
    const row = makeSuggestion(
      { status },
      { hunks: [{ start: 0, end: 1, removed: 'a', added: 'b' }] },
    );
    db.comments.set(row.id, row);
    renderSuggestion(row);
    const card = screen.getByRole('region', { name: /^Suggestion/ });
    expect(within(card).getByText(text)).toBeInTheDocument();
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
  });

  it('says how many of the changes a partial accept applied', () => {
    const row = makeSuggestion(
      { status: 'accepted' },
      {
        hunks: [1, 2, 3].map(() => ({ start: 0, end: 0, removed: '', added: 'x' })),
        appliedHunks: [0, 2],
      },
    );
    db.comments.set(row.id, row);
    renderSuggestion(row);
    expect(screen.getByText('2 of 3 changes applied.')).toBeInTheDocument();
  });
});

describe('suggestion inside a comment thread', () => {
  it("renders the copilot's answer under the comment that prompted it, with the same actions", async () => {
    const root = makeComment({ id: 'thread-1', bodyMarkdown: '@copilot shorter please' });
    const { row } = await pendingSuggestion({
      params: { shorter: true },
      overrides: { threadId: root.id, parentId: root.id },
    });
    db.comments.set(root.id, root);
    renderSuggestion(row, { root, replies: [row] });
    expect(screen.getByText('@copilot shorter please')).toBeInTheDocument();
    expect(screen.getByText('Copilot')).toBeInTheDocument();
    expect(screen.getByText('Ready to review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    // The comment's own actions are still there.
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeInTheDocument();
  });
});
