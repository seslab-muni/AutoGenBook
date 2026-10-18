import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from '@codemirror/view';
import { NodeSelection } from 'prosemirror-state';
import { beforeEach, describe, expect, it } from 'vitest';

import { editorInternals } from '@/features/editor/wysiwyg/dom-test-utils';
import { posOf, press, select, type } from '@/features/editor/wysiwyg/test-harness';
import { db } from '@/mocks/db';
import { server } from '@/mocks/server';
import { useEditorStore } from '@/stores/editor-store';
import { renderRouterApp } from '@/test/router-test-utils';

// One test per file for routed studio tests that mount the manuscript chunk: see
// `manuscript-sheet-readonly.route.test.tsx`.
const LONG = { timeout: 10000 };

function cm(): EditorView {
  const dom = document.querySelector('.cm-editor') as HTMLElement | null;
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) throw new Error('CodeMirror view not mounted');
  return view;
}

beforeEach(() => useEditorStore.setState({ view: 'write' }));

describe('Studio editor pane (routed) — switching between Write and Source', () => {
  it('carries the draft and the caret both ways, and "Edit in Source" on an atom opens Source on its text', async () => {
    const user = userEvent.setup();
    const bodies: { contentMarkdown?: string }[] = [];
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'PATCH' && request.url.includes('/outline/')) {
        bodies.push((await request.clone().json()) as (typeof bodies)[number]);
      }
    });
    const original = db.outlineNodes.get('rl-sec-1-1')!.contentMarkdown;
    renderRouterApp('/p/book-reinforcement-learning?node=rl-sec-1-1');
    await waitFor(() => {
      if (!document.querySelector('.md-editor')) throw new Error('the editor is not mounted yet');
    }, LONG);

    // Type in Write, then switch to Source mid-edit: the typed text is there, the caret is where it was.
    act(() => {
      const { view } = editorInternals();
      select(view, posOf(view, 'Because', 3));
      type(view, 'ABC');
    });
    await user.click(screen.getByRole('radio', { name: 'Source' }));
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull(), LONG);
    const typedAt = original.indexOf('Because') + 3;
    expect(cm().state.doc.toString()).toBe(
      original.slice(0, typedAt) + 'ABC' + original.slice(typedAt),
    );
    expect(cm().state.selection.main.head).toBe(typedAt + 3);
    expect(document.querySelector('.md-editor')).toBeNull();

    // Type in Source, switch back: Write shows both edits, with the caret carried over.
    act(() => cm().dispatch({ changes: { from: 0, insert: 'S' } }));
    await user.click(screen.getByRole('radio', { name: 'Write' }));
    await waitFor(() => expect(document.querySelector('.md-editor')).not.toBeNull(), LONG);
    const { core, view } = editorInternals();
    expect(core.text).toBe('S' + original.slice(0, typedAt) + 'ABC' + original.slice(typedAt));
    expect(core.model.posToSrc(view.state.selection.from, 'start')).toBe(typedAt + 4);

    // Everything typed is saved once, from whichever view it was typed in.
    await waitFor(() => expect(bodies.at(-1)?.contentMarkdown).toBe(core.text), LONG);

    // An atom is edited in Source: Enter on the selected formula switches there with its text selected.
    let atom = -1;
    view.state.doc.descendants((node, pos) => {
      if (atom < 0 && node.type.name === 'atom_inline') atom = pos;
      return atom < 0;
    });
    act(() => {
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, atom)));
      press(view, 'Enter');
    });
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull(), LONG);
    const selected = cm().state.sliceDoc(
      cm().state.selection.main.from,
      cm().state.selection.main.to,
    );
    expect(selected).toBe('$\\pi_k$');
  }, 40000);
});
