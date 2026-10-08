import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { editorInternals, selectInEditor } from '@/features/editor/wysiwyg/dom-test-utils';
import { press } from '@/features/editor/wysiwyg/test-harness';
import { useMarginStore } from '@/features/editor/margin/margin-store';
import { db } from '@/mocks/db';
import { useEditorStore } from '@/stores/editor-store';
import { useUiStore } from '@/stores/ui-store';
import { renderRouterApp } from '@/test/router-test-utils';

// One test per file for routed studio tests that mount the manuscript chunk: see
// `manuscript-sheet-readonly.route.test.tsx`.
const LONG = { timeout: 10000 };

beforeEach(() => {
  useEditorStore.setState({ view: 'write' });
  useUiStore.setState({ marginOpen: true, rightOverlayOpen: false });
  useMarginStore.getState().reset();
});

describe('Copilot in the editable Write view (routed)', () => {
  it('Prompt… -> Accept puts the suggestion into the editor outside its undo history, and the toast undoes it', async () => {
    const user = userEvent.setup();
    const original = db.outlineNodes.get('rl-sec-1-1')!.contentMarkdown;
    renderRouterApp('/p/book-reinforcement-learning?node=rl-sec-1-1');
    await waitFor(() => {
      if (!document.querySelector('.md-editor')) throw new Error('the editor is not mounted yet');
    }, LONG);
    await screen.findByRole('complementary', { name: 'Margin' }, LONG);

    selectInEditor('Because a finite MDP');
    const bar = await screen.findByRole('toolbar', { name: 'Selection actions' }, LONG);
    await user.click(within(bar).getByRole('button', { name: 'Prompt…' }));
    await user.type(
      await screen.findByRole('textbox', { name: 'Instruction for the copilot' }),
      'add an example{Control>}{Enter}{/Control}',
    );
    const card = await screen.findByRole('region', { name: /^Suggestion by/ }, LONG);
    await within(card).findByText('Ready to review', { exact: true }, LONG);
    await user.click(within(card).getByRole('button', { name: 'Accept' }));

    // The accepted text is in the editor, and the source is the server's text byte for byte.
    await waitFor(() => expect(editorInternals().core.text).toContain('As requested'), LONG);
    const accepted = db.outlineNodes.get('rl-sec-1-1')!.contentMarkdown;
    expect(accepted).not.toBe(original);
    expect(editorInternals().core.text).toBe(accepted);
    expect(screen.getByRole('textbox', { name: 'Section text' })).toHaveTextContent(/As requested/);

    // Ctrl+Z does not undo the adoption (it is not in the editor's history).
    act(() => {
      press(editorInternals().view, 'z', { ctrl: true });
    });
    expect(editorInternals().core.text).toBe(accepted);

    // The toast's Undo is the way back: a content write guarded by the hash, adopted the same way.
    await user.click(await screen.findByRole('button', { name: 'Undo' }, LONG));
    await waitFor(() => expect(editorInternals().core.text).toBe(original), LONG);
    expect(db.outlineNodes.get('rl-sec-1-1')!.contentMarkdown).toBe(original);
  }, 60000);
});
