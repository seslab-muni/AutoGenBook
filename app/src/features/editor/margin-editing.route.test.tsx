import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from '@codemirror/view';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeAnchor } from '@/features/editor/lib/anchors';
import { makeComment } from '@/features/editor/margin/test-helpers';
import { useMarginStore } from '@/features/editor/margin/margin-store';
import { db } from '@/mocks/db';
import { server } from '@/mocks/server';
import { useEditorStore } from '@/stores/editor-store';
import { useUiStore } from '@/stores/ui-store';
import { renderRouterApp } from '@/test/router-test-utils';
import { setViewportWidth } from '@/test/viewport';

const LONG = { timeout: 10000 };
const NODE = 'rl-sec-1-1';
const NODE_URL = `/p/book-reinforcement-learning?node=${NODE}`;
const TEXT =
  'Alpha beta gamma delta.\nThe theorem statement holds for every input here.\nAlpha again and beta again.\n';

function editorView(): EditorView {
  const dom = document.querySelector('.cm-editor') as HTMLElement | null;
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) throw new Error('CodeMirror view not mounted');
  return view;
}

/** Puts `content` into the mock section and a comment on `quote`; returns where the quote starts. */
function seed(content: string, quote: string, id = 'seed') {
  const node = db.outlineNodes.get(NODE)!;
  db.outlineNodes.set(NODE, { ...node, contentMarkdown: content });
  const lf = content.replace(/\r\n/g, '\n');
  const start = lf.indexOf(quote);
  db.comments.set(
    id,
    makeComment({
      id,
      projectId: node.projectId,
      nodeId: NODE,
      anchor: makeAnchor(lf, start, start + quote.length),
      bodyMarkdown: 'Seeded',
    }),
  );
  return start;
}

const marks = () =>
  [...document.querySelectorAll('.cm-content .anchor-mark')]
    .map((mark) => mark.textContent)
    .join('');

async function open() {
  renderRouterApp(NODE_URL);
  await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull(), LONG);
  await waitFor(() => expect(marks()).not.toBe(''), LONG);
}

beforeEach(() => {
  useEditorStore.setState({ view: 'source' });
  useUiStore.setState({ rightPane: 'margin', copilotOpen: true, rightOverlayOpen: false });
  useMarginStore.getState().reset();
});

describe('Source view: anchors follow real edits', () => {
  it('keeps a comment on its words through a replace-all elsewhere (a multi-range change)', async () => {
    seed(TEXT, 'theorem statement');
    await open();
    const view = editorView();
    const changes = [...TEXT.matchAll(/Alpha/g)].map((m) => ({
      from: m.index!,
      to: m.index! + 5,
      insert: 'Omega-long',
    }));
    expect(changes).toHaveLength(2);
    act(() => view.dispatch({ changes }));
    expect(marks()).toBe('theorem statement');
    expect(screen.queryByText('Orphaned')).not.toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Comment by Ada Researcher on “theorem statement”' }),
    ).toBeInTheDocument();
  }, 30000);

  it('does not grow the highlight when text is typed right before it', async () => {
    const start = seed(TEXT, 'theorem statement');
    await open();
    const view = editorView();
    act(() => view.dispatch({ changes: { from: start, insert: 'the ' } }));
    expect(marks()).toBe('theorem statement');
  }, 30000);

  it('un-orphans a comment when its deleted words come back (undo)', async () => {
    const user = userEvent.setup();
    const start = seed(TEXT, 'theorem statement');
    await open();
    const view = editorView();
    await user.click(document.querySelector('.cm-content')!);
    act(() =>
      view.dispatch({
        changes: { from: start, to: start + 'theorem statement'.length },
        userEvent: 'delete',
      }),
    );
    expect(await screen.findByText('Orphaned', {}, LONG)).toBeInTheDocument();
    expect(marks()).toBe('');
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(marks()).toBe('theorem statement'), LONG);
    await waitFor(() => expect(screen.queryByText('Orphaned')).not.toBeInTheDocument(), LONG);
  }, 30000);

  it('makes no effects-only dispatch per keystroke once highlights exist', async () => {
    const user = userEvent.setup();
    const start = seed(TEXT, 'theorem statement');
    await open();
    const view = editorView();
    const original = view.dispatch.bind(view);
    const calls: boolean[] = [];
    view.dispatch = ((...specs: Parameters<EditorView['dispatch']>) => {
      const first = specs[0] as { effects?: unknown; changes?: unknown } | undefined;
      calls.push(Boolean(first && 'effects' in first && first.effects && !first.changes));
      return original(...(specs as [never]));
    }) as EditorView['dispatch'];
    act(() => view.dispatch({ selection: { anchor: start } }));
    calls.length = 0;
    await user.keyboard('abc');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls.some(Boolean)).toBe(false);
    expect(marks()).toBe('theorem statement');
  }, 30000);

  it('does not touch the editor with highlight updates while an IME composition is running', async () => {
    seed(TEXT, 'theorem statement');
    await open();
    const view = editorView();
    const original = view.dispatch.bind(view);
    let effectDispatches = 0;
    view.dispatch = ((...specs: Parameters<EditorView['dispatch']>) => {
      const first = specs[0] as { effects?: unknown } | undefined;
      if (first && 'effects' in first && first.effects) effectDispatches += 1;
      return original(...(specs as [never]));
    }) as EditorView['dispatch'];
    Object.defineProperty(view, 'composing', { value: true, configurable: true });
    // A new comment arrives (another user's) while composing: the highlight set changes.
    const node = db.outlineNodes.get(NODE)!;
    const at = TEXT.indexOf('Alpha again');
    db.comments.set(
      'other',
      makeComment({
        id: 'other',
        projectId: node.projectId,
        nodeId: NODE,
        anchor: makeAnchor(TEXT, at, at + 11),
      }),
    );
    await act(async () => {
      // Force the comments query to refetch.
      await screen.findByRole('region', { name: /Comment by/ }, LONG);
    });
    const before = effectDispatches;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(effectDispatches).toBe(before);
    expect(marks()).toBe('theorem statement');
  }, 30000);
});

describe('line endings', () => {
  it('counts a CR LF section over LF text: highlights and new anchors line up', async () => {
    const user = userEvent.setup();
    const crlf = TEXT.replace(/\n/g, '\r\n');
    seed(crlf, 'theorem statement');
    // The server's anchor was made over the CR LF text; drop its offsets as a stale server would not.
    await open();
    expect(marks()).toBe('theorem statement');
    const view = editorView();
    expect(view.state.doc.toString()).toBe(TEXT);

    // A new comment on a range after a line break is anchored over LF text.
    let posted: { anchor: { start: number; end: number; quote: string } } | undefined;
    server.use(
      http.post('*/api/v1/projects/:projectId/outline/:nodeId/comments', async ({ request }) => {
        posted = (await request.json()) as typeof posted;
        return HttpResponse.json(
          makeComment({ id: 'new', anchor: posted!.anchor, bodyMarkdown: 'x' }),
          { status: 201 },
        );
      }),
    );
    const from = TEXT.indexOf('Alpha again');
    act(() => view.dispatch({ selection: { anchor: from, head: from + 11 } }));
    await user.click(await screen.findByRole('button', { name: 'Comment' }));
    await user.type(
      await screen.findByRole('textbox', { name: 'New comment' }),
      'hi{Control>}{Enter}{/Control}',
    );
    await waitFor(() => expect(posted).toBeDefined(), LONG);
    expect(posted!.anchor.start).toBe(from);
    expect(posted!.anchor.quote).toBe('Alpha again');
  }, 30000);
});

describe('typed text survives a failed request', () => {
  it('keeps the new-comment composer open with its text and shows the server message, then sends on retry', async () => {
    const user = userEvent.setup();
    seed(TEXT, 'theorem statement');
    await open();
    const view = editorView();
    const from = TEXT.indexOf('Alpha again');
    act(() => view.dispatch({ selection: { anchor: from, head: from + 11 } }));
    let attempts = 0;
    server.use(
      http.post('*/api/v1/projects/:projectId/outline/:nodeId/comments', async ({ request }) => {
        attempts += 1;
        if (attempts === 1) {
          return HttpResponse.json(
            {
              type: 'about:blank',
              title: 'Server error',
              status: 500,
              detail: 'database is down',
              instance: '/x',
            },
            { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
          );
        }
        const body = (await request.json()) as { bodyMarkdown: string };
        return HttpResponse.json(makeComment({ id: 'sent', bodyMarkdown: body.bodyMarkdown }), {
          status: 201,
        });
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Comment' }));
    const box = await screen.findByRole('textbox', { name: 'New comment' });
    await user.type(box, 'Precious words{Control>}{Enter}{/Control}');
    const alert = await screen.findByRole('alert', {}, LONG);
    expect(alert).toHaveTextContent('Not sent: database is down');
    expect(screen.getByRole('textbox', { name: 'New comment' })).toHaveValue('Precious words');
    // Retry from the same composer.
    await user.click(screen.getByRole('button', { name: 'Comment' }));
    await waitFor(() => expect(attempts).toBe(2), LONG);
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'New comment' })).not.toBeInTheDocument(),
    );
  }, 30000);

  it('keeps a reply open with its text when the request fails', async () => {
    const user = userEvent.setup();
    seed(TEXT, 'theorem statement');
    await open();
    server.use(
      http.post('*/api/v1/projects/:projectId/outline/:nodeId/comments', () =>
        HttpResponse.error(),
      ),
    );
    const card = await screen.findByRole('region', { name: /^Comment by Ada/ }, LONG);
    await user.click(within(card).getByRole('button', { name: 'Reply' }));
    await user.type(
      within(card).getByRole('textbox', { name: 'Reply' }),
      'long reply{Control>}{Enter}{/Control}',
    );
    expect(await within(card).findByRole('alert', {}, LONG)).toBeInTheDocument();
    expect(within(card).getByRole('textbox', { name: 'Reply' })).toHaveValue('long reply');
  }, 30000);
});

describe('narrow screens: the margin is a managed side sheet', () => {
  it('opens on Comment without changing the saved wide-screen preference, keeps the selection visible by making room, and closes on Escape from the editor', async () => {
    const user = userEvent.setup();
    setViewportWidth(1024);
    useUiStore.setState({ copilotOpen: false });
    seed(TEXT, 'theorem statement');
    renderRouterApp(NODE_URL);
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull(), LONG);
    expect(screen.queryByRole('complementary', { name: 'Margin' })).not.toBeInTheDocument();

    const view = editorView();
    act(() => view.dispatch({ selection: { anchor: 0, head: 11 } }));
    await user.click(await screen.findByRole('button', { name: 'Comment' }));
    expect(await screen.findByRole('complementary', { name: 'Margin' }, LONG)).toBeInTheDocument();
    expect(useUiStore.getState().copilotOpen).toBe(false);
    const editorColumn = document.querySelector('.cm-editor')!.closest('[style*="padding-right"]');
    expect(editorColumn).not.toBeNull();

    // Escape in the composer closes the composer only; Escape again from the editor closes the sheet.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'New comment' })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Margin' })).toBeInTheDocument();
    act(() => view.focus());
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Margin' })).not.toBeInTheDocument(),
    );
  }, 30000);

  it('has a visible close button', async () => {
    const user = userEvent.setup();
    setViewportWidth(1024);
    useUiStore.setState({ rightOverlayOpen: true });
    seed(TEXT, 'theorem statement');
    renderRouterApp(NODE_URL);
    await user.click(await screen.findByRole('button', { name: 'Close right pane' }, LONG));
    expect(screen.queryByRole('complementary', { name: 'Margin' })).not.toBeInTheDocument();
  }, 30000);
});

describe('keyboard: a highlight to its card', () => {
  it('Ctrl+Alt+M with the caret inside a highlight moves focus to that card', async () => {
    const user = userEvent.setup();
    const start = seed(TEXT, 'theorem statement');
    await open();
    const view = editorView();
    act(() => view.dispatch({ selection: { anchor: start + 4 } }));
    await user.click(document.querySelector('.cm-content')!);
    act(() => view.dispatch({ selection: { anchor: start + 4 } }));
    view.focus();
    await user.keyboard('{Control>}{Alt>}m{/Alt}{/Control}');
    const card = await screen.findByRole('region', { name: /^Comment by Ada/ }, LONG);
    await waitFor(() => expect(card).toHaveFocus());
    expect(screen.queryByRole('textbox', { name: 'New comment' })).not.toBeInTheDocument();
  }, 30000);
});

vi.setConfig({ testTimeout: 30000 });

describe('server content changing under an open editor', () => {
  it('adopts it when there are no unsaved edits, and re-resolves the anchors against it', async () => {
    seed(TEXT, 'theorem statement');
    const rendered = renderRouterApp(NODE_URL);
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull(), LONG);
    await waitFor(() => expect(marks()).toBe('theorem statement'), LONG);

    const changed = 'A brand new first line.\n' + TEXT;
    const node = db.outlineNodes.get(NODE)!;
    db.outlineNodes.set(NODE, { ...node, contentMarkdown: changed });
    await act(async () => {
      await rendered.queryClient.invalidateQueries({ queryKey: ['projects'] });
    });
    await waitFor(() => expect(editorView().state.doc.toString()).toBe(changed), LONG);
    await waitFor(() => expect(marks()).toBe('theorem statement'), LONG);
    expect(screen.queryByText(/changed elsewhere/)).not.toBeInTheDocument();
  }, 30000);

  it('keeps unsaved edits and says so instead of overwriting them', async () => {
    const user = userEvent.setup();
    seed(TEXT, 'theorem statement');
    const rendered = renderRouterApp(NODE_URL);
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull(), LONG);
    await user.click(document.querySelector('.cm-content')!);
    await user.keyboard('typing');
    // Held up in flight so the edit is still unsaved when the other change lands.
    server.use(
      http.patch('*/api/v1/projects/:projectId/outline/:nodeId', async () => {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return HttpResponse.json(db.outlineNodes.get(NODE)!);
      }),
    );
    const mine = editorView().state.doc.toString();
    const node = db.outlineNodes.get(NODE)!;
    db.outlineNodes.set(NODE, { ...node, contentMarkdown: 'Somebody else rewrote this.' });
    await act(async () => {
      await rendered.queryClient.invalidateQueries({ queryKey: ['projects'] });
    });
    const notice = (await screen.findByText(/changed elsewhere/, {}, LONG)).closest(
      '[role="status"]',
    ) as HTMLElement;
    expect(editorView().state.doc.toString()).toBe(mine);
    await user.click(within(notice).getByRole('button', { name: 'Load the other version' }));
    await waitFor(
      () => expect(editorView().state.doc.toString()).toBe('Somebody else rewrote this.'),
      LONG,
    );
    expect(screen.queryByText(/changed elsewhere/)).not.toBeInTheDocument();
  }, 30000);
});
