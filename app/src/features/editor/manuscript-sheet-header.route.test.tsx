import { act, screen, within } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { describe, expect, it } from 'vitest';

import { renderRouterApp } from '@/test/router-test-utils';

// `ManuscriptSheet` is a lazily-loaded chunk (see manuscript-sheet-preview.route.test.tsx).
const LONG = { timeout: 10000 };
const ROUTE = '/p/book-consensus-quantum-2026?node=sec-1-1';

describe('Studio editor header and status bar (routed, MSW-backed)', () => {
  it('renders the lock, Write/Source, Chapter options and a disabled Copilot button', async () => {
    renderRouterApp(ROUTE);

    expect(await screen.findByRole('button', { name: 'Lock content' }, LONG)).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'Write', checked: true })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Source', checked: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chapter options' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Copilot' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  }, 15000);

  it('opens Chapter options as a popover from the header chip', async () => {
    const user = userEvent.setup();
    renderRouterApp(ROUTE);

    await user.click(await screen.findByRole('button', { name: 'Chapter options' }, LONG));
    const popover = await screen.findByRole('dialog', { name: 'Chapter options' });
    expect(within(popover).getByRole('textbox', { name: 'Sub-prompt' })).toBeInTheDocument();
    expect(await within(popover).findByRole('radiogroup', { name: 'Source scope' })).toBeVisible();
  }, 15000);

  it('opens the sources drawer from the status bar and Change scope leads to Chapter options', async () => {
    const user = userEvent.setup();
    renderRouterApp(ROUTE);

    await user.click(await screen.findByRole('button', { name: /^\d+ sources?$/ }, LONG));
    const drawer = await screen.findByRole('region', { name: 'Sources for this section' });
    expect(await within(drawer).findByRole('list', { name: 'Effective sources' })).toBeVisible();

    await user.click(within(drawer).getByRole('button', { name: 'Change scope' }));
    expect(screen.queryByRole('region', { name: 'Sources for this section' })).toBeNull();
    expect(await screen.findByRole('dialog', { name: 'Chapter options' })).toBeVisible();
  }, 15000);

  it('shows the caret in the Source view and moves it without reconfiguring CodeMirror', async () => {
    const user = userEvent.setup();
    renderRouterApp(ROUTE);

    expect(screen.queryByText(/^Ln \d+, Col \d+$/)).not.toBeInTheDocument();
    await user.click(await screen.findByRole('radio', { name: 'Source' }, LONG));
    expect(await screen.findByText(/^Ln \d+, Col \d+$/, {}, LONG)).toBeInTheDocument();

    const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
    const dispatch = vi.spyOn(view, 'dispatch');
    act(() => view.dispatch({ selection: { anchor: 3 } }));
    act(() => view.dispatch({ selection: { anchor: 5 } }));
    expect(screen.getByText('Ln 1, Col 6')).toBeInTheDocument();
    // Our two dispatches only: a reconfigure would add a third from the CodeMirror wrapper.
    expect(dispatch).toHaveBeenCalledTimes(2);
  }, 20000);
});
