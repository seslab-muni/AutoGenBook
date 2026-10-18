import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SelectionToolbar } from './selection-toolbar';

const RECT = { top: 120, bottom: 140, left: 200, right: 300 };

describe('SelectionToolbar', () => {
  it('offers only Comment by default (no dead copilot buttons)', async () => {
    const onComment = vi.fn();
    render(<SelectionToolbar rect={RECT} containerWidth={800} onComment={onComment} />);
    const bar = screen.getByRole('toolbar', { name: 'Selection actions' });
    expect(bar).toBeInTheDocument();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Comment']);
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(onComment).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Comment' })).toHaveAttribute(
      'aria-keyshortcuts',
      'Control+Alt+M',
    );
  });

  it('shows Prompt… and the quick chips only behind the copilot flag', async () => {
    const onChip = vi.fn();
    const onPrompt = vi.fn();
    render(
      <SelectionToolbar
        rect={RECT}
        containerWidth={800}
        onComment={vi.fn()}
        onChip={onChip}
        onPrompt={onPrompt}
      />,
    );
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Comment',
      'Prompt…',
      'Add proof',
      'More rigorous',
      'Shorter',
      'Cite',
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Shorter' }));
    expect(onChip).toHaveBeenCalledWith('Shorter');
    await userEvent.click(screen.getByRole('button', { name: 'Prompt…' }));
    expect(onPrompt).toHaveBeenCalled();
  });

  it('does not steal focus or the selection from the text on a pointer press', () => {
    render(
      <div>
        <input aria-label="text" />
        <SelectionToolbar rect={RECT} containerWidth={800} onComment={vi.fn()} />
      </div>,
    );
    const input = screen.getByLabelText('text');
    input.focus();
    // `fireEvent` returns false when the default (which would move focus) was cancelled.
    const proceeded = fireEvent.mouseDown(screen.getByRole('button', { name: 'Comment' }));
    expect(proceeded).toBe(false);
    expect(input).toHaveFocus();
  });

  it('sits above the selection, below it when there is no room, and stays inside the pane', () => {
    const { rerender } = render(
      <SelectionToolbar rect={RECT} containerWidth={800} onComment={vi.fn()} />,
    );
    const bar = () => screen.getByRole('toolbar');
    expect(parseFloat(bar().style.top)).toBeLessThan(RECT.top);
    rerender(
      <SelectionToolbar
        rect={{ top: 10, bottom: 30, left: 790, right: 800 }}
        containerWidth={800}
        onComment={vi.fn()}
      />,
    );
    expect(parseFloat(bar().style.top)).toBeGreaterThan(30);
    expect(parseFloat(bar().style.left)).toBeLessThanOrEqual(800);
  });
});
