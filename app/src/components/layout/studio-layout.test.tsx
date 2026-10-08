import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { useUiStore } from '@/stores/ui-store';
import { setViewportWidth } from '@/test/viewport';

import { StudioLayout } from './studio-layout';

function renderLayout() {
  render(
    <StudioLayout
      outlinePane={<div>outline</div>}
      editorPane={<button type="button">in the editor</button>}
      marginPane={
        <div>
          right column <button type="button">inside</button>
        </div>
      }
    />,
  );
}

beforeEach(() => {
  useUiStore.setState({ outlineOpen: true, marginOpen: true, rightOverlayOpen: false });
});

describe('StudioLayout right column', () => {
  it('sits beside the editor at 1280px and wider', () => {
    setViewportWidth(1280);
    renderLayout();
    const column = screen.getByText(/right column/).parentElement!;
    expect(column.className).toContain('w-[376px]');
    expect(column.className).not.toContain('absolute');
  });

  it('floats over the editor below 1280px, stays closed until asked for, and leaves the wide-screen preference alone', async () => {
    const user = userEvent.setup();
    setViewportWidth(1024);
    useUiStore.setState({ marginOpen: false });
    renderLayout();
    expect(screen.queryByText(/right column/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show right pane' }));
    const column = screen.getByText(/right column/).parentElement!;
    expect(column.className).toContain('absolute');
    expect(useUiStore.getState().marginOpen).toBe(false);
    // The editor makes room for the side sheet instead of being covered by it.
    expect(screen.getByRole('button', { name: 'in the editor' }).closest('[style]')).toHaveStyle({
      paddingRight: '376px',
    });
  });

  it('closes on Escape from anywhere, including focus in the editor', async () => {
    const user = userEvent.setup();
    setViewportWidth(1024);
    useUiStore.setState({ rightOverlayOpen: true });
    renderLayout();
    expect(screen.getByText(/right column/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'in the editor' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByText(/right column/)).not.toBeInTheDocument();
  });

  it('closes on a press outside it, but not on one inside it or in a dialog it opened', async () => {
    const user = userEvent.setup();
    setViewportWidth(1024);
    useUiStore.setState({ rightOverlayOpen: true });
    render(
      <>
        <StudioLayout
          outlinePane={<div>outline</div>}
          editorPane={<button type="button">in the editor</button>}
          marginPane={<button type="button">inside</button>}
        />
        <div role="alertdialog">a confirm dialog</div>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'inside' }));
    await user.click(screen.getByText('a confirm dialog'));
    expect(screen.getByRole('button', { name: 'inside' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'in the editor' }));
    expect(screen.queryByRole('button', { name: 'inside' })).not.toBeInTheDocument();
  });

  it('does not close on a press on a copilot entry point (it opens the sheet itself)', async () => {
    const user = userEvent.setup();
    setViewportWidth(1024);
    useUiStore.setState({ rightOverlayOpen: true });
    render(
      <StudioLayout
        outlinePane={<div>outline</div>}
        editorPane={
          <>
            <button type="button" data-copilot-trigger>
              Copilot
            </button>
            <div role="toolbar" aria-label="Selection actions">
              <button type="button">Prompt…</button>
            </div>
          </>
        }
        marginPane={<button type="button">inside</button>}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Copilot' }));
    await user.click(screen.getByRole('button', { name: 'Prompt…' }));
    expect(screen.getByRole('button', { name: 'inside' })).toBeInTheDocument();
  });

  it('keeps the editor pane unpadded at wide widths', () => {
    setViewportWidth(1440);
    renderLayout();
    expect(screen.getByRole('button', { name: 'in the editor' }).closest('[style]')).toBeNull();
  });
});
