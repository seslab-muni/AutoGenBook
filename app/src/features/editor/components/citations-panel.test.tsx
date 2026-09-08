import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { RagCitation } from '@/features/editor/lib/rag-citation';

import { CitationsPanel } from './citations-panel';

const CITATIONS: RagCitation[] = [
  {
    id: 'c-1',
    sourceDoc: 'Low_Relevance.pdf',
    sectionSnippet: 'A less relevant passage.',
    relevanceScore: 0.4,
  },
  {
    id: 'c-2',
    sourceDoc: 'Lamport_1982_ByzantineGenerals.pdf',
    pageNumber: 4,
    sectionSnippet: 'A set of generals of the Byzantine army...',
    relevanceScore: 0.98,
    authorYear: 'Lamport et al., 1982',
  },
];

describe('CitationsPanel', () => {
  it('shows an empty state when there are no citations', () => {
    render(<CitationsPanel citations={[]} />);
    expect(screen.getByText('No citations yet')).toBeInTheDocument();
  });

  it('shows an empty state when citations is undefined', () => {
    render(<CitationsPanel citations={undefined} />);
    expect(screen.getByText('No citations yet')).toBeInTheDocument();
  });

  it('sorts citations by relevanceScore, highest first', () => {
    render(<CitationsPanel citations={CITATIONS} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Lamport et al., 1982');
    expect(rows[1]).toHaveTextContent('Low_Relevance.pdf');
  });

  it('shows the page number and relevance percentage', () => {
    render(<CitationsPanel citations={CITATIONS} />);
    expect(screen.getByText('p. 4')).toBeInTheDocument();
    expect(screen.getByText('98%')).toBeInTheDocument();
  });

  it('calls onOpenSource with the sourceDoc when a citation is clicked', async () => {
    const user = userEvent.setup();
    const onOpenSource = vi.fn();
    render(<CitationsPanel citations={CITATIONS} onOpenSource={onOpenSource} />);

    await user.click(screen.getByText('Lamport et al., 1982'));
    expect(onOpenSource).toHaveBeenCalledWith('Lamport_1982_ByzantineGenerals.pdf');
  });
});
