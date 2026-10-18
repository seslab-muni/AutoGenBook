import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WriteBody } from './write-body';

/**
 * The editor module is its own chunk. These tests stand in for the network: `loads` counts how often
 * the chunk was asked for.
 */
const control = vi.hoisted(() => ({ loads: 0 }));
vi.mock('@/features/editor/wysiwyg/markdown-editor', async (importOriginal) => {
  control.loads += 1;
  return importOriginal();
});

const LONG = { timeout: 10000 };

const baseProps = {
  markdown: '# Title\n\nSome **bold** text and $x^2$ and [@k].\n\n| a |\n| - |\n| 1 |\n',
  citations: [],
  anchorMarks: [],
  focusedAnchorId: null,
  highlights: [],
  onCitationClick: vi.fn(),
  onAnchorClick: vi.fn(),
  emptyNote: <p>Nothing here</p>,
  editorProps: { onChange: vi.fn(), onFlush: vi.fn() },
};

beforeEach(() => {
  control.loads = 0;
});

describe('WriteBody', () => {
  it('paints the read-only text first and swaps in the editor in the same place', async () => {
    render(<WriteBody {...baseProps} editable />);
    // First paint: the read-only renderer (no editor yet).
    expect(document.querySelector('.md-editor')).toBeNull();
    await waitFor(() => expect(document.querySelector('.md-editor')).not.toBeNull(), LONG);
    const editor = document.querySelector<HTMLElement>('.md-editor')!;
    expect(within(editor).getByRole('heading', { level: 1, name: 'Title' })).toBeInTheDocument();
    expect(editor).toHaveAttribute('contenteditable', 'true');
    // Formulas and tables are shown by the read-only renderers, as atoms.
    await waitFor(() => expect(editor.querySelector('.katex')).not.toBeNull(), LONG);
    await waitFor(() => expect(editor.querySelector('table')).not.toBeNull(), LONG);
    expect(control.loads).toBe(1);
  });

  it('never loads the editor for a section that cannot be edited', async () => {
    render(<WriteBody {...baseProps} editable={false} />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Title' }, LONG),
    ).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.querySelector('.md-editor')).toBeNull();
    expect(control.loads).toBe(0);
  });

  it('shows the empty-section note when the text is empty and cannot be edited', () => {
    render(<WriteBody {...baseProps} markdown="" editable={false} />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('shows a placeholder for an empty section that can be edited, then the editor', async () => {
    render(<WriteBody {...baseProps} markdown="" editable />);
    expect(screen.getByText('Start writing…')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.md-editor')).not.toBeNull(), LONG);
  });
});
