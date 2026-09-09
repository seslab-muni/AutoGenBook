import userEvent from '@testing-library/user-event';
import { screen } from '@testing-library/react';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/component-test-utils';

import { OutlineDraftEditor } from './outline-draft-editor';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const PROJECT_ID = 'book-consensus-quantum-2026';

function renderEditor(maxOutlineLevels = 4) {
  return renderWithProviders(
    <OutlineDraftEditor
      projectId={PROJECT_ID}
      maxOutlineLevels={maxOutlineLevels}
      open
      onOpenChange={() => {}}
    />,
  );
}

function pasteTextarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/paste a plain list/i) as HTMLTextAreaElement;
}

function depthOf(title: string): number {
  const input = screen.getByDisplayValue(title);
  const row = input.parentElement;
  const paddingLeft = row instanceof HTMLElement ? row.style.paddingLeft : '';
  return Number.parseInt(paddingLeft || '0', 10) / 20;
}

async function parse(text: string) {
  const user = userEvent.setup();
  await user.click(pasteTextarea());
  await user.paste(text);
  await user.click(screen.getByRole('button', { name: 'Parse into outline' }));
}

describe('OutlineDraftEditor pasted-outline parsing', () => {
  it('disables the parse button until there is non-whitespace text to parse', async () => {
    renderEditor();
    expect(screen.getByRole('button', { name: 'Parse into outline' })).toBeDisabled();

    const user = userEvent.setup();
    await user.click(pasteTextarea());
    await user.paste('   \n\t\n   ');
    expect(screen.getByRole('button', { name: 'Parse into outline' })).toBeDisabled();
  });

  it('builds flat top-level chapters from a plain newline-separated list', async () => {
    renderEditor();
    await parse('Introduction\nMethods\nResults');

    expect(depthOf('Introduction')).toBe(0);
    expect(depthOf('Methods')).toBe(0);
    expect(depthOf('Results')).toBe(0);
  });

  it('nests Markdown headings by level', async () => {
    renderEditor();
    await parse('# Chapter 1\n## Section 1.1\n### Sub 1.1.1\n# Chapter 2');

    expect(depthOf('Chapter 1')).toBe(0);
    expect(depthOf('Section 1.1')).toBe(1);
    expect(depthOf('Sub 1.1.1')).toBe(2);
    expect(depthOf('Chapter 2')).toBe(0);
  });

  it('nests dotted numbered headings by segment count', async () => {
    renderEditor();
    await parse('1. Chapter 1\n1.1 Section\n1.1.1 Subsection\n2. Chapter 2');

    expect(depthOf('Chapter 1')).toBe(0);
    expect(depthOf('Section')).toBe(1);
    expect(depthOf('Subsection')).toBe(2);
    expect(depthOf('Chapter 2')).toBe(0);
  });

  it('clamps nesting to maxOutlineLevels instead of producing unreachable rows', async () => {
    renderEditor(2);
    await parse('# A\n## B\n### C\n#### D');

    expect(depthOf('A')).toBe(0);
    // B, C and D all collapse onto the deepest allowed level (1) rather than crashing or
    // silently disappearing.
    expect(depthOf('B')).toBe(1);
    expect(depthOf('C')).toBe(1);
    expect(depthOf('D')).toBe(1);
  });

  it('clears the paste box and replaces the draft after a successful parse', async () => {
    renderEditor();
    await parse('Chapter A\nChapter B');

    expect(pasteTextarea()).toHaveValue('');
    // The initial blank starter row is gone, replaced entirely by the parsed nodes.
    expect(screen.getAllByPlaceholderText('Chapter title')).toHaveLength(2);
  });

  it('falls back to literal titles for garbage-looking lines instead of dropping them', async () => {
    renderEditor();
    // Bare bullet markers, stray punctuation, and heading-shaped lines with no title text all
    // survive as literal titles rather than crashing or silently vanishing.
    await parse('- \n* \n#\n1.\n???');

    expect(toast.error).not.toHaveBeenCalled();
    for (const title of ['-', '*', '#', '1.', '???']) {
      expect(screen.getByDisplayValue(title)).toBeInTheDocument();
    }
  });

  it('does not crash on a large, irregular paste and still yields a usable draft', async () => {
    const lines = Array.from({ length: 500 }, (_, i) =>
      i % 3 === 0 ? `# Heading ${i}` : i % 3 === 1 ? `${i}.${i} Numbered ${i}` : `Plain ${i}`,
    );
    renderEditor();
    await parse(lines.join('\n'));

    expect(toast.error).not.toHaveBeenCalled();
    expect(await screen.findByDisplayValue('Heading 0')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Plain 2')).toBeInTheDocument();
  });
});
