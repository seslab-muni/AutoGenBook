import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { WriteBody } from './write-body';

/** The editor chunk cannot be fetched (a network error, a deploy that removed it): the first request fails. */
const control = vi.hoisted(() => ({ failures: 1, loads: 0 }));
vi.mock('@/features/editor/wysiwyg/markdown-editor', async (importOriginal) => {
  control.loads += 1;
  if (control.failures > 0) {
    control.failures -= 1;
    throw new Error('Failed to fetch dynamically imported module');
  }
  return importOriginal();
});

const LONG = { timeout: 10000 };

describe('WriteBody when the editor chunk cannot be loaded', () => {
  it('stays read-only with a notice, keeps the text readable, and loads the editor on Try again', async () => {
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
        editorProps={{ onChange: vi.fn(), onFlush: vi.fn() }}
      />,
    );
    const notice = await screen.findByRole('status', {}, LONG);
    expect(notice).toHaveTextContent('The editor could not be loaded, so this view is read-only');
    expect(notice).toHaveTextContent('Switch to Source to edit');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Title' }, LONG),
    ).toBeInTheDocument();
    expect(document.querySelector('.md-editor')).toBeNull();

    await user.click(within(notice).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(document.querySelector('.md-editor')).not.toBeNull(), LONG);
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
    expect(control.loads).toBe(2);
  });
});
