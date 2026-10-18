import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WriteBody } from './write-body';

/**
 * The editor chunk cannot be fetched (a network error, a deploy that removed it). A browser
 * remembers a failed dynamic import for the page's lifetime, so the stand-in fails the same way
 * every time it is asked: asking again in place can never help, and the test counts the asks.
 */
const control = vi.hoisted(() => ({ loads: 0 }));
vi.mock('@/features/editor/wysiwyg/markdown-editor', () => {
  control.loads += 1;
  throw new Error('Failed to fetch dynamically imported module');
});

const LONG = { timeout: 10000 };

const original = window.location;
afterEach(() => {
  Object.defineProperty(window, 'location', { value: original, configurable: true });
});

describe('WriteBody when the editor chunk cannot be loaded', () => {
  it('stays read-only with a notice, keeps the text readable, and offers a reload (not a retry that cannot work)', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...original, reload },
      configurable: true,
    });
    const onFlush = vi.fn();
    const user = userEvent.setup();
    render(
      <WriteBody
        editable
        markdown={'# Title\n\nSome text.\n'}
        citations={[]}
        anchorMarks={[]}
        focusedAnchorId={null}
        highlights={[]}
        onCitationClick={vi.fn()}
        onAnchorClick={vi.fn()}
        emptyNote={null}
        editorProps={{ onChange: vi.fn(), onFlush }}
      />,
    );
    const notice = await screen.findByRole('status', {}, LONG);
    expect(notice).toHaveTextContent('The editor could not be loaded, so this view is read-only');
    expect(notice).toHaveTextContent('Reload the page to try again');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Title' }, LONG),
    ).toBeInTheDocument();
    expect(document.querySelector('.md-editor')).toBeNull();
    // The read-only text is no longer announced as a busy textbox.
    expect(document.querySelector('[data-write-pending]')).toBeNull();
    expect(within(notice).queryByRole('button', { name: 'Try again' })).toBeNull();

    await user.click(within(notice).getByRole('button', { name: 'Reload page' }));
    // What is unsaved is saved first, then the page is reloaded.
    expect(onFlush).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), LONG);
    // The chunk was asked for once: a second ask in place would hit the same cached failure.
    expect(control.loads).toBe(1);
  });
});
