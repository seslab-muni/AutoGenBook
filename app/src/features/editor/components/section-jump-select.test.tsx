import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { OutlineNode } from '@/api/types';

import { SectionJumpSelect } from './section-jump-select';

function node(overrides: Partial<OutlineNode>): OutlineNode {
  return {
    id: 'id',
    parentId: null,
    orderIndex: 0,
    cliKey: null,
    title: 'Untitled',
    summary: '',
    level: 0,
    sectionNumber: '',
    status: 'not_started',
    targetPages: 1,
    wordBudget: 350,
    actualWords: 0,
    equationDensityLevel: 3,
    mathLevel: 'rigorous',
    subPrompt: null,
    contentMarkdown: '',
    contentLatex: '',
    ragCitations: [],
    reviewerScore: null,
    reviewerNotes: null,
    structureLocked: true,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

const FLAT: OutlineNode[] = [
  node({ id: 'ch-2', parentId: null, orderIndex: 1, title: 'Chapter Two' }),
  node({ id: 'ch-1', parentId: null, orderIndex: 0, title: 'Chapter One' }),
  node({ id: 'sec-1-1', parentId: 'ch-1', orderIndex: 0, title: 'Section One' }),
];

describe('SectionJumpSelect', () => {
  it('renders nothing when the outline is empty', () => {
    const { container } = render(
      <SectionJumpSelect flat={[]} selectedNodeId={null} onSelectNode={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists sections flattened and numbered', async () => {
    const user = userEvent.setup();
    render(<SectionJumpSelect flat={FLAT} selectedNodeId="ch-1" onSelectNode={vi.fn()} />);

    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('option', { name: /§1 Chapter One/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /§1\.1 Section One/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /§2 Chapter Two/ })).toBeInTheDocument();
  });

  it('calls onSelectNode with the chosen node id', async () => {
    const user = userEvent.setup();
    const onSelectNode = vi.fn();
    render(<SectionJumpSelect flat={FLAT} selectedNodeId="ch-1" onSelectNode={onSelectNode} />);

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: /Chapter Two/ }));
    expect(onSelectNode).toHaveBeenCalledWith('ch-2');
  });
});
