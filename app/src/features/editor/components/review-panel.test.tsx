import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ReviewPanel } from './review-panel';

describe('ReviewPanel', () => {
  it('shows an empty state when there are no reviewer notes', () => {
    render(<ReviewPanel reviewerScore={null} reviewerNotes={null} />);
    expect(screen.getByText('No review for this section')).toBeInTheDocument();
  });

  it('shows an empty state when reviewerNotes is undefined', () => {
    render(<ReviewPanel reviewerScore={undefined} reviewerNotes={undefined} />);
    expect(screen.getByText('No review for this section')).toBeInTheDocument();
  });

  it('renders the reviewer score and notes as Markdown', async () => {
    render(
      <ReviewPanel
        reviewerScore={8.5}
        reviewerNotes={'Solid section. **Missing**: a worked example.'}
      />,
    );
    expect(screen.getByText('8.5 / 10')).toBeInTheDocument();
    // Markdown rendering is behind a lazy-loaded Suspense boundary (`LazyMarkdownView`).
    expect(await screen.findByText('Missing')).toBeInTheDocument();
  });

  it('renders notes without a score badge when reviewerScore is absent', async () => {
    render(<ReviewPanel reviewerScore={null} reviewerNotes="Needs more citations." />);
    expect(screen.queryByText(/\/ 10/)).not.toBeInTheDocument();
    expect(await screen.findByText('Needs more citations.')).toBeInTheDocument();
  });
});
