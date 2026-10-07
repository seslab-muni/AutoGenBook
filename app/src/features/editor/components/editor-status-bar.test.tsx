import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorSelectionStore } from '@/stores/editor-selection-store';

import { EditorStatusBar } from './editor-status-bar';

function renderBar(overrides: Partial<React.ComponentProps<typeof EditorStatusBar>> = {}) {
  const onToggleSources = vi.fn();
  const onCloseSources = vi.fn();
  render(
    <EditorStatusBar
      characters={8412}
      words={1380}
      sourceCount={3}
      sourcesOpen={false}
      sourcesDrawerId="drawer"
      onToggleSources={onToggleSources}
      showCaret
      onCloseSources={onCloseSources}
      {...overrides}
    />,
  );
  return { onToggleSources, onCloseSources };
}

describe('EditorStatusBar', () => {
  beforeEach(() => {
    useEditorSelectionStore.setState({
      selection: { from: 10, to: 10, line: 14, column: 37 },
    });
  });

  it('shows character and word counts, the source count and the caret position', () => {
    renderBar();
    expect(screen.getByText('8,412 characters · 1,380 words')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3 sources' })).toBeInTheDocument();
    expect(screen.getByText('Ln 14, Col 37')).toBeInTheDocument();
  });

  it('uses the singular for one source', () => {
    renderBar({ sourceCount: 1 });
    expect(screen.getByRole('button', { name: '1 source' })).toBeInTheDocument();
  });

  it('hides the caret readout when there is no caret (Write view)', () => {
    renderBar({ showCaret: false });
    expect(screen.queryByText(/^Ln /)).not.toBeInTheDocument();
  });

  it('follows the selection store without re-rendering the bar', async () => {
    renderBar();
    act(() => {
      useEditorSelectionStore.getState().setSelection({ from: 0, to: 5, line: 1, column: 6 });
    });
    expect(screen.getByText('Ln 1, Col 6')).toBeInTheDocument();
  });

  it('shows no count while the source list is loading', () => {
    renderBar({ sourceCount: null });
    expect(screen.getByRole('button', { name: 'Loading sources…' })).toBeInTheDocument();
  });

  it('shows an error label instead of a count when the sources failed to load', () => {
    renderBar({ sourceCount: 0, sourcesError: true });
    expect(screen.getByRole('button', { name: 'Sources unavailable' })).toBeInTheDocument();
  });

  it('closes the open drawer on Escape from the sources button', async () => {
    const user = userEvent.setup();
    const { onCloseSources } = renderBar({ sourcesOpen: true });
    screen.getByRole('button', { name: '3 sources' }).focus();
    await user.keyboard('{Escape}');
    expect(onCloseSources).toHaveBeenCalledTimes(1);
  });

  it('toggles the sources drawer and reports its state to assistive tech', async () => {
    const user = userEvent.setup();
    const { onToggleSources } = renderBar({ sourcesOpen: true });
    const button = screen.getByRole('button', { name: '3 sources' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAttribute('aria-controls', 'drawer');
    await user.click(button);
    expect(onToggleSources).toHaveBeenCalledTimes(1);
  });
});
