import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { OutlineNode } from '@/api/types';

import { CopilotDrawer } from './copilot-drawer';

const NODE: OutlineNode = {
  id: 'n1',
  parentId: null,
  orderIndex: 0,
  cliKey: '1',
  title: 'Introduction',
  summary: '',
  level: 1,
  sectionNumber: '1',
  status: 'compiled',
  targetPages: 2,
  wordBudget: 700,
  actualWords: 500,
  equationDensityLevel: 3,
  mathLevel: 'rigorous',
  subPrompt: null,
  contentMarkdown: '',
  contentLatex: '',
  ragCitations: [
    {
      id: 'c-1',
      sourceDoc: 'Doc.pdf',
      sectionSnippet: 'snippet',
      relevanceScore: 0.9,
    },
  ],
  reviewerScore: 6,
  reviewerNotes: 'Good start.',
  structureLocked: true,
  createdAt: '',
  updatedAt: '',
};

describe('CopilotDrawer', () => {
  it('renders the Copilot placeholder without touching #21 content, and switches to Citations', async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(<CopilotDrawer node={NODE} tab="copilot" onTabChange={onTabChange} />);

    expect(screen.getByText('Multi-agent stream coming soon')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Citations' }));
    expect(onTabChange).toHaveBeenCalledWith('citations');
  });

  it('shows citations when the citations tab is active and a node is selected', () => {
    render(<CopilotDrawer node={NODE} tab="citations" onTabChange={vi.fn()} />);
    expect(screen.getByText('Doc.pdf')).toBeInTheDocument();
  });

  it('shows an empty state for citations/review when no node is selected', () => {
    render(<CopilotDrawer node={null} tab="citations" onTabChange={vi.fn()} />);
    expect(screen.getByText('No section selected')).toBeInTheDocument();
  });

  it('shows the review tab content when active', async () => {
    render(<CopilotDrawer node={NODE} tab="review" onTabChange={vi.fn()} />);
    expect(screen.getByText('6.0 / 10')).toBeInTheDocument();
    // Markdown rendering is behind a lazy-loaded Suspense boundary (`LazyMarkdownView`).
    expect(await screen.findByText('Good start.')).toBeInTheDocument();
  });

  it('shows the selected section in the status bar', () => {
    render(<CopilotDrawer node={NODE} tab="copilot" onTabChange={vi.fn()} />);
    expect(screen.getByText('§1 Introduction')).toBeInTheDocument();
  });
});
