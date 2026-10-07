import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Source } from '@/api/types';

import { SourcesDrawer } from './sources-drawer';

function source(id: string, name: string, chunksCount: number | null = 12): Source {
  return {
    id,
    fileId: `file-${id}`,
    name,
    sizeBytes: 1,
    type: 'pdf',
    chunksCount,
    status: 'ready',
    uploadDate: '2026-01-01T00:00:00Z',
  } as Source;
}

const CITATIONS = [
  { id: 'a', sourceDoc: 'Gottesman.pdf', relevanceScore: 0.9 },
  { id: 'b', sourceDoc: 'Gottesman.pdf', relevanceScore: 0.8 },
];

function renderDrawer(overrides: Partial<React.ComponentProps<typeof SourcesDrawer>> = {}) {
  const onChangeScope = vi.fn();
  const onClose = vi.fn();
  render(
    <SourcesDrawer
      id="drawer"
      sources={[source('s1', 'Gottesman.pdf'), source('s2', 'Knill.pdf', null)]}
      failedSources={[]}
      loading={false}
      error={false}
      onRetry={vi.fn()}
      scope={{ kind: 'selected', own: false, fromNodeId: 'ch', sourceIds: ['s1', 's2'] }}
      scopeFromLabel="§3 Quantum codes"
      citations={CITATIONS}
      onChangeScope={onChangeScope}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onChangeScope, onClose };
}

describe('SourcesDrawer', () => {
  it('lists the effective sources with how often each is cited in the section', () => {
    renderDrawer();
    const items = within(screen.getByRole('list', { name: 'Effective sources' })).getAllByRole(
      'listitem',
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Gottesman.pdf');
    expect(items[0]).toHaveTextContent('12 chunks · 2 passages cited (last run)');
    expect(items[1]).toHaveTextContent('Knill.pdf');
    expect(items[1]).toHaveTextContent('not cited in last run');
    expect(screen.getByText('Scope: inherited from §3 Quantum codes')).toBeInTheDocument();
  });

  it('describes the resolved scope', () => {
    renderDrawer({ scope: { kind: 'all', own: false, fromNodeId: null } });
    expect(screen.getByText('Scope: all project sources')).toBeInTheDocument();
  });

  it('lists failed sources as not searched and shows a loading state', () => {
    renderDrawer({ failedSources: [{ ...source('s3', 'Broken.pdf'), status: 'error' }] });
    expect(screen.getByText('Broken.pdf')).toBeInTheDocument();
    expect(screen.getByText('Indexing failed, not searched')).toBeInTheDocument();
  });

  it('shows a loading line instead of the empty message while sources load', () => {
    renderDrawer({ sources: [], loading: true });
    expect(screen.getByText('Loading sources…')).toBeInTheDocument();
    expect(screen.queryByText(/No sources are attached/)).not.toBeInTheDocument();
  });

  it('shows an error line with Retry instead of an empty message', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderDrawer({ sources: [], error: true, onRetry });
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load this project's sources.");
    expect(screen.queryByText(/No sources are attached/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape that happens outside the drawer', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDrawer();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers Change scope and closes on Escape inside the drawer', async () => {
    const user = userEvent.setup();
    const { onChangeScope, onClose } = renderDrawer();
    await user.click(screen.getByRole('button', { name: 'Change scope' }));
    expect(onChangeScope).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says so when the project has no sources', () => {
    renderDrawer({ sources: [] });
    expect(screen.getByText(/No sources are attached/)).toBeInTheDocument();
  });

  it('switches to the Citations list (what the old right-pane tab held)', async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    renderDrawer({ onViewChange });
    await user.click(screen.getByRole('radio', { name: 'Citations (2)' }));
    expect(onViewChange).toHaveBeenCalledWith('citations');
  });

  it('lists the citations, best match first, when that view is active', () => {
    renderDrawer({
      view: 'citations',
      citations: [
        {
          id: 'low',
          sourceDoc: 'Low.pdf',
          relevanceScore: 0.2,
          sectionSnippet: 's',
          pageNumber: 1,
        },
        {
          id: 'high',
          sourceDoc: 'High.pdf',
          relevanceScore: 0.9,
          sectionSnippet: 's',
          pageNumber: 2,
        },
      ],
    });
    expect(screen.getByText('Citations in this section')).toBeInTheDocument();
    const names = screen.getAllByRole('button', { name: /\.pdf/ }).map((b) => b.textContent);
    expect(names).toEqual(['High.pdf', 'Low.pdf']);
    expect(screen.queryByRole('list', { name: 'Effective sources' })).not.toBeInTheDocument();
  });
});
