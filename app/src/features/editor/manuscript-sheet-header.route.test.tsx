import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderRouterApp } from '@/test/router-test-utils';

// `ManuscriptSheet` is a lazily-loaded chunk (see manuscript-sheet-preview.route.test.tsx).
const LONG = { timeout: 10000 };
const ROUTE = '/p/book-consensus-quantum-2026?node=sec-1-1';

describe('Studio editor header and status bar (routed, MSW-backed)', () => {
  it('renders the lock, Write/Source, Chapter options and a disabled Copilot button', async () => {
    renderRouterApp(ROUTE);

    expect(await screen.findByRole('button', { name: 'Lock content' }, LONG)).toBeEnabled();
    expect(screen.getByRole('tab', { name: 'Write', selected: true })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Source', selected: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chapter options' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Copilot' })).toBeDisabled();
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
});
