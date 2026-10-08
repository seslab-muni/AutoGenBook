import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Bot } from 'lucide-react';

import { MARGIN_CARD_KINDS, type MarginCardContext } from './card-registry';
import { MarginCard } from './margin-card';
import { makeComment, makeThread } from './test-helpers';

const CTX: MarginCardContext = {
  projectId: 'p',
  nodeId: 'n',
  currentUserId: null,
  copilotActions: false,
  restoreEditorFocus: vi.fn(),
  applyServerContent: vi.fn(),
  hasUnsavedEdits: () => false,
  flushEdits: () => Promise.resolve(),
  holdSaving: () => Promise.resolve(() => {}),
};

const original = { ...MARGIN_CARD_KINDS };
afterEach(() => Object.assign(MARGIN_CARD_KINDS, original));

function renderKind(kind: string) {
  const root = makeComment({
    id: 'x',
    kind: kind as 'suggestion',
    authorId: null,
    authorName: null,
    bodyMarkdown: 'body text',
  });
  render(
    <MarginCard
      thread={makeThread(root)}
      ctx={CTX}
      register={() => {}}
      top={0}
      focused={false}
      onFocusCard={() => {}}
    />,
  );
}

describe('card registry slots', () => {
  it('lets a kind replace the header status, the quote area and the body', () => {
    MARGIN_CARD_KINDS.suggestion = {
      label: 'Suggestion',
      icon: Bot,
      Status: () => <span>running 40%</span>,
      Quote: () => <pre>- old text + new text</pre>,
      Body: ({ ctx }) => <button type="button">Accept {ctx.projectId}</button>,
    };
    renderKind('suggestion');
    const card = screen.getByRole('region', { name: /^Suggestion/ });
    expect(within(card).getByText('running 40%')).toBeInTheDocument();
    expect(within(card).getByText('- old text + new text')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Accept p' })).toBeInTheDocument();
    // The defaults it replaced are gone.
    expect(within(card).queryByText('Whole section')).not.toBeInTheDocument();
  });

  it('renders a kind this client does not know read-only, with the default status', () => {
    renderKind('mystery');
    const card = screen.getByRole('region', { name: /^Note/ });
    expect(within(card).getByText('body text')).toBeInTheDocument();
    expect(within(card).getByText('Whole section')).toBeInTheDocument();
  });
});
