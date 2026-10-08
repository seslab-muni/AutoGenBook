import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { WriteBody } from './write-body';

/** The editor chunk is slow: it arrives when the test lets it. */
const gate = vi.hoisted(() => {
  const state = { release: () => {} };
  const promise = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  return { ...state, promise };
});
vi.mock('@/features/editor/wysiwyg/markdown-editor', async (importOriginal) => {
  await gate.promise;
  return importOriginal();
});

const LONG = { timeout: 10000 };

describe('WriteBody while the editor is loading', () => {
  it('keeps what is typed into the read-only text and puts it into the editor when it arrives', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <WriteBody
        editable
        markdown={'Some text.\n'}
        citations={[]}
        anchorMarks={[]}
        focusedAnchorId={null}
        highlights={[]}
        onCitationClick={vi.fn()}
        onAnchorClick={vi.fn()}
        emptyNote={null}
        editorProps={{ onChange, onFlush: vi.fn() }}
      />,
    );
    const pending = document.querySelector<HTMLElement>('[data-write-pending]')!;
    // A busy, read-only textbox that already takes the keyboard.
    expect(pending).toHaveAttribute('role', 'textbox');
    expect(pending).toHaveAttribute('aria-busy', 'true');
    expect(pending).toHaveAttribute('aria-readonly', 'true');
    pending.focus();
    expect(document.activeElement).toBe(pending);
    await user.keyboard('Hi{Backspace}ey');
    // Nothing yet: the text is read-only and the typed keys wait.
    expect(onChange).not.toHaveBeenCalled();
    expect(document.querySelector('.md-editor')).toBeNull();

    gate.release();
    await waitFor(() => expect(document.querySelector('.md-editor')).not.toBeNull(), LONG);
    const editor = document.querySelector<HTMLElement>('.md-editor')!;
    // Replayed in order (H, i, Backspace, e, y) at the start of the text, and the editor has the focus.
    await waitFor(() => expect(editor.textContent).toBe('HeySome text.'), LONG);
    expect(document.activeElement).toBe(editor);
    expect(onChange).toHaveBeenLastCalledWith('HeySome text.\n');
  });
});
