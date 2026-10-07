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
    expect(items[0]).toHaveTextContent('12 chunks · cited 2× here');
    expect(items[1]).toHaveTextContent('Knill.pdf');
    expect(items[1]).toHaveTextContent('not cited yet');
    expect(screen.getByText('Scope: inherited from §3 Quantum codes')).toBeInTheDocument();
  });

  it('describes the resolved scope', () => {
    renderDrawer({ scope: { kind: 'all', own: false, fromNodeId: null } });
    expect(screen.getByText('Scope: all project sources')).toBeInTheDocument();
  });

  it('offers Change scope and closes on Escape', async () => {
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
});
