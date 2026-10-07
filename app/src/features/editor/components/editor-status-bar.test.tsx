import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { EditorStatusBar } from './editor-status-bar';

function renderBar(overrides: Partial<React.ComponentProps<typeof EditorStatusBar>> = {}) {
  const onToggleSources = vi.fn();
  render(
    <EditorStatusBar
      characters={8412}
      words={1380}
      sourceCount={3}
      sourcesOpen={false}
      sourcesDrawerId="drawer"
      onToggleSources={onToggleSources}
      caret={{ line: 14, column: 37 }}
      {...overrides}
    />,
  );
  return { onToggleSources };
}

describe('EditorStatusBar', () => {
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
    renderBar({ caret: null });
    expect(screen.queryByText(/^Ln /)).not.toBeInTheDocument();
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
