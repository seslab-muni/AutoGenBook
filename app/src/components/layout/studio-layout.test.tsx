import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useUiStore } from '@/stores/ui-store';

import { StudioLayout } from './studio-layout';

const realMatchMedia = window.matchMedia;

function setWidth(width: number) {
  window.matchMedia = ((query: string) => {
    const min = /\(min-width:\s*(\d+)px\)/.exec(query);
    return {
      matches: min ? width >= Number(min[1]) : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  }) as typeof window.matchMedia;
}

function renderLayout() {
  render(
    <StudioLayout
      outlinePane={<div>outline</div>}
      editorPane={<div>editor</div>}
      copilotPane={<div>right column</div>}
    />,
  );
}

beforeEach(() => {
  useUiStore.setState({ outlineOpen: true, copilotOpen: true, rightOverlayOpen: false });
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

describe('StudioLayout right column', () => {
  it('sits beside the editor at 1280px and wider', () => {
    setWidth(1280);
    renderLayout();
    const column = screen.getByText('right column').parentElement!;
    expect(column.className).toContain('w-[376px]');
    expect(column.className).not.toContain('absolute');
  });

  it('floats over the editor below 1280px and stays closed until asked for', async () => {
    const user = userEvent.setup();
    setWidth(1024);
    renderLayout();
    expect(screen.queryByText('right column')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show copilot pane' }));
    const column = screen.getByText('right column').parentElement!;
    expect(column.className).toContain('absolute');
    expect(screen.getByText('editor')).toBeInTheDocument();

    // Escape inside the overlay closes it.
    await user.click(screen.getByText('right column'));
    await user.keyboard('{Escape}');
    expect(screen.queryByText('right column')).not.toBeInTheDocument();
    // The persisted wide-screen preference is untouched.
    expect(useUiStore.getState().copilotOpen).toBe(true);
  });
});
