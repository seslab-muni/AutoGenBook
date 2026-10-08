import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/mocks/db';
import { renderWithProviders } from '@/test/component-test-utils';

import { MarginCard } from './margin-card';
import { useMarginStore } from './margin-store';
import { ReviewSummaryStrip } from './review-summary-strip';
import { makeComment, makeContext, makeReview, makeThread } from './test-helpers';
import type { MarginCardContext } from './card-registry';
import type { Comment } from '@/api/types';

function renderReview(
  review: Comment,
  options: { replies?: Comment[]; ctx?: Partial<MarginCardContext> } = {},
) {
  for (const row of [review, ...(options.replies ?? [])]) db.comments.set(row.id, row);
  const thread = makeThread(review, {
    replies: options.replies ?? [],
    range: review.anchor ? { start: 4, end: 20 } : null,
  });
  return renderWithProviders(
    <MarginCard
      thread={thread}
      ctx={makeContext(options.ctx)}
      register={() => {}}
      top={0}
      focused={false}
      onFocusCard={vi.fn()}
    />,
  );
}

beforeEach(() => {
  useMarginStore.setState({ drafts: {} });
});

describe('review card', () => {
  it('shows the severity and type pills, the quote, the description and the required fix', () => {
    renderReview(makeReview());
    const card = screen.getByRole('region', {
      name: 'Review issue, major Coverage: Termination is stated but never argued for.',
    });
    // Major is spelled out (and carries its own icon), so it does not rest on colour.
    expect(within(card).getByText('Major')).toHaveAttribute('data-severity', 'major');
    expect(within(card).getByText('Coverage')).toBeInTheDocument();
    expect(within(card).getByText('the quoted words')).toBeInTheDocument();
    expect(
      within(card).getByText('Termination is stated but never argued for.'),
    ).toBeInTheDocument();
    expect(within(card).getByText('Required fix')).toBeInTheDocument();
    expect(within(card).getByText('Add a short argument.')).toBeInTheDocument();
    expect(within(card).getByText('Reviewer')).toBeInTheDocument();
  });

  it('marks a minor issue as Minor, a consistency issue and a citation note by their source', () => {
    renderReview(
      makeReview(
        { anchor: null },
        { severity: 'minor', type: 'consistency:term', source: 'consistency' },
      ),
    );
    expect(screen.getByText('Minor')).toHaveAttribute('data-severity', 'minor');
    expect(screen.getByText('Consistency: term')).toBeInTheDocument();
    expect(screen.getByText('Consistency check')).toBeInTheDocument();
    expect(screen.getByText('Whole section')).toBeInTheDocument();
  });

  it('renders the citation provenance', () => {
    renderReview(makeReview({}, { source: 'citation', type: 'citation' }));
    expect(screen.getByText('Citation check')).toBeInTheDocument();
  });

  it('shows the from -> to chips only when the reviewer gave both halves', () => {
    const first = renderReview(makeReview({}, { replaceFrom: 'decide on', replaceTo: 'output' }));
    const chips = screen.getByLabelText('Replace “decide on” with “output”');
    expect(within(chips).getByText('decide on')).toBeInTheDocument();
    expect(within(chips).getByText('output')).toBeInTheDocument();
    first.unmount();

    const second = renderReview(makeReview({}, { replaceFrom: 'decide on', replaceTo: '' }));
    expect(screen.queryByLabelText(/^Replace “/)).not.toBeInTheDocument();
    second.unmount();

    renderReview(makeReview({}, { replaceFrom: '', replaceTo: 'output' }));
    expect(screen.queryByLabelText(/^Replace “/)).not.toBeInTheDocument();
  });

  it('clamps a long description and required fix to a few lines, with Show more', async () => {
    const user = userEvent.setup();
    const long = 'A very long observation about the section. '.repeat(12);
    renderReview(makeReview({ bodyMarkdown: long }, { requiredFix: long }));
    const more = screen.getAllByRole('button', { name: 'Show more' });
    expect(more).toHaveLength(2);
    const paragraph = screen.getAllByText(long.trim())[0]!;
    expect(paragraph.className).toContain('line-clamp-4');
    await user.click(more[0]!);
    expect(paragraph.className).not.toContain('line-clamp-4');
    expect(screen.getAllByRole('button', { name: 'Show less' })).toHaveLength(1);
  });

  it('reads a missing severity as minor, the server default', () => {
    renderReview(makeReview({}, { severity: undefined }));
    expect(screen.getByText('Minor')).toHaveAttribute('data-severity', 'minor');
    expect(screen.queryByText('Major')).not.toBeInTheDocument();
  });

  it('flags an outdated issue that a newer review no longer reports', () => {
    renderReview(makeReview({ status: 'resolved' }, { outdated: true }));
    expect(screen.getByText('Outdated')).toBeInTheDocument();
    expect(screen.queryByText('Dismissed')).not.toBeInTheDocument();
  });

  it('says Dismissed on a dismissed issue and offers Reopen', () => {
    renderReview(makeReview({ status: 'resolved' }));
    expect(screen.getByText('Dismissed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fix with Copilot' })).not.toBeInTheDocument();
  });

  it('Dismiss resolves the issue through the resolve endpoint', async () => {
    const user = userEvent.setup();
    const review = makeReview();
    renderReview(review);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(db.comments.get(review.id)?.status).toBe('resolved'));
  });

  it('Fix with Copilot needs a handler, and hands the thread over', async () => {
    const user = userEvent.setup();
    const first = renderReview(makeReview(), { ctx: { onFixWithCopilot: undefined } });
    expect(screen.queryByRole('button', { name: 'Fix with Copilot' })).not.toBeInTheDocument();
    first.unmount();

    const onFix = vi.fn();
    const review = makeReview();
    renderReview(review, { ctx: { onFixWithCopilot: onFix } });
    await user.click(screen.getByRole('button', { name: 'Fix with Copilot' }));
    expect(onFix).toHaveBeenCalledWith(expect.objectContaining({ id: review.id, kind: 'review' }));
  });

  it('allows replies under a review issue, shown as messages below it', async () => {
    const user = userEvent.setup();
    const review = makeReview();
    renderReview(review, {
      replies: [
        makeComment({
          id: 'r1',
          threadId: review.id,
          parentId: review.id,
          anchor: review.anchor,
          bodyMarkdown: 'Will do tomorrow.',
        }),
      ],
    });
    expect(await screen.findByText('Will do tomorrow.')).toBeInTheDocument();
    // The issue's own text is not turned into a message with an author: only the reply is editable.
    expect(screen.getAllByRole('button', { name: /^Edit comment/ })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await user.type(screen.getByRole('textbox', { name: 'Reply' }), 'Done.');
    await user.click(screen.getAllByRole('button', { name: 'Reply' }).at(-1)!);
    await waitFor(() => {
      const rows = [...db.comments.values()].filter((row) => row.threadId === review.id);
      expect(rows.map((row) => row.bodyMarkdown)).toContain('Done.');
    });
  });
});

describe('review summary strip', () => {
  function renderStrip(
    summary: Parameters<typeof ReviewSummaryStrip>[0]['summary'],
    threads = [] as ReturnType<typeof makeThread>[],
    score: number | null = null,
  ) {
    return renderWithProviders(
      <ReviewSummaryStrip summary={summary} threads={threads} score={score} legacyNotes={null} />,
    );
  }

  const summary = {
    okToKeep: false,
    issueCount: 3,
    suggestedEdits: ['Add a proof sketch.', 'Unify the terms.'],
    retrievalQueries: ['partial synchrony proof'],
    reviewedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  };

  it('shows the Needs revision verdict and the counts of the open review cards', () => {
    renderStrip(summary, [
      makeThread(makeReview({ id: 'a' }, { severity: 'major' })),
      makeThread(makeReview({ id: 'b' }, { severity: 'major' })),
      makeThread(makeReview({ id: 'c' }, { severity: 'minor' })),
      // Dismissed cards are not counted; comments are not review cards.
      makeThread(makeReview({ id: 'd', status: 'resolved' }, { severity: 'minor' })),
      makeThread(makeComment({ id: 'e' })),
    ]);
    const strip = screen.getByRole('region', { name: 'Review summary' });
    expect(within(strip).getByText('Needs revision')).toHaveAttribute(
      'data-verdict',
      'needs-revision',
    );
    expect(within(strip).getByText('2 major · 1 minor')).toBeInTheDocument();
    expect(within(strip).getByText(/Reviewed 3 d ago/)).toBeInTheDocument();
  });

  it('shows OK to keep with No issues found when the reviewer found none', () => {
    renderStrip({
      ...summary,
      okToKeep: true,
      issueCount: 0,
      suggestedEdits: [],
      retrievalQueries: [],
    });
    const strip = screen.getByRole('region', { name: 'Review summary' });
    expect(within(strip).getByText('OK to keep')).toHaveAttribute('data-verdict', 'ok');
    expect(within(strip).getByText('No issues found')).toBeInTheDocument();
    expect(within(strip).queryByText(/major/)).not.toBeInTheDocument();
    // No empty disclosures.
    expect(within(strip).queryByText(/Suggested edits/)).not.toBeInTheDocument();
  });

  it('keeps the suggested edits and the evidence searches closed until asked, as panels over the cards', async () => {
    const user = userEvent.setup();
    renderStrip(summary);
    const edits = screen.getByRole('button', { name: 'Suggested edits (2)' });
    const searches = screen.getByRole('button', {
      name: 'Searches that would find missing evidence (1)',
    });
    expect(edits).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Add a proof sketch.')).not.toBeInTheDocument();
    await user.click(edits);
    expect(edits).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: 'Suggested edits' })).toHaveTextContent(
      'Add a proof sketch.',
    );
    // One at a time; the same button closes it, and so does Escape inside the panel.
    await user.click(searches);
    expect(screen.queryByText('Add a proof sketch.')).not.toBeInTheDocument();
    expect(screen.getByText('partial synchrony proof')).toBeVisible();
    await user.click(searches);
    expect(screen.queryByText('partial synchrony proof')).not.toBeInTheDocument();
    await user.click(edits);
    screen.getByRole('region', { name: 'Suggested edits' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByText('Add a proof sketch.')).not.toBeInTheDocument();
  });

  it('shows the notes of a review from before review rows existed as a plain list', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ReviewSummaryStrip
        summary={null}
        threads={[]}
        score={null}
        legacyNotes={'[minor] terminology: use Systems Dynamics'}
      />,
    );
    expect(screen.getByText(/reviewed before issues became cards/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review notes (previous run)' }));
    expect(screen.getByText('[minor] terminology: use Systems Dynamics')).toBeInTheDocument();
  });

  it('shows the reviewer score when the run produced one', () => {
    renderStrip(summary, [], 7.5);
    expect(screen.getByText('7.5 / 10')).toBeInTheDocument();
  });
});
