import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from '@codemirror/view';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MARGIN_CARD_KINDS } from '@/features/editor/margin/card-registry';
import { makeAnchor } from '@/features/editor/lib/anchors';
import { useMarginStore } from '@/features/editor/margin/margin-store';
import { useUndoneSuggestions } from '@/features/editor/margin/use-suggestion-actions';
import { db, mockRevisionConfig } from '@/mocks/db';
import { server } from '@/mocks/server';
import { useEditorStore } from '@/stores/editor-store';
import { useUiStore } from '@/stores/ui-store';
import { renderRouterApp } from '@/test/router-test-utils';
import { setViewportWidth } from '@/test/viewport';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), message: vi.fn() }));
vi.mock('sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('sonner')>()),
  toast: toasts,
}));

const LONG = { timeout: 15000 };
const NODE_URL = '/p/book-reinforcement-learning?node=rl-sec-1-1';
const NODE_ID = 'rl-sec-1-1';
const SENTENCE = 'Because a finite MDP has only finitely many deterministic policies';

function editorView(): EditorView {
  const dom = document.querySelector('.cm-editor') as HTMLElement | null;
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) throw new Error('CodeMirror view not mounted');
  return view;
}
const editorText = () => editorView().state.doc.toString();
const serverText = () => db.outlineNodes.get(NODE_ID)!.contentMarkdown;

/** Non-GET requests from now on, as `METHOD path` plus the body's text for PATCHes. */
function recordWrites() {
  const writes: string[] = [];
  const bodies: { key: string; body: Record<string, unknown> }[] = [];
  const listener = ({ request }: { request: Request }) => {
    if (request.method === 'GET') return;
    const key = `${request.method} ${new URL(request.url).pathname}`;
    writes.push(key);
    void request
      .clone()
      .json()
      .then((body) => bodies.push({ key, body: body as Record<string, unknown> }))
      .catch(() => {});
  };
  server.events.on('request:start', listener);
  return { writes, bodies, stop: () => server.events.removeListener('request:start', listener) };
}

async function openSource() {
  const view = renderRouterApp(NODE_URL);
  await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull(), LONG);
  await screen.findByRole('complementary', { name: 'Margin' }, LONG);
  return view;
}

/** A pending section suggestion made through the real UI (header Copilot), ready to accept. */
async function pendingSuggestion(
  user: ReturnType<typeof userEvent.setup>,
  instruction = 'extend it',
) {
  await user.click(screen.getByRole('button', { name: 'Copilot' }));
  await user.type(
    await screen.findByRole('textbox', { name: 'Instruction for the copilot' }),
    `${instruction}{Control>}{Enter}{/Control}`,
  );
  const card = await screen.findByRole('region', { name: /^Suggestion by/ }, LONG);
  await within(card).findByText('Ready to review', {}, LONG);
  return card;
}

const type = (text: string, at = 0) =>
  act(() =>
    editorView().dispatch({ changes: { from: at, insert: text }, userEvent: 'input.type' }),
  );

beforeEach(() => {
  mockRevisionConfig.stepMs = 5;
  useEditorStore.setState({ view: 'source' });
  useUiStore.setState({ marginOpen: true, rightOverlayOpen: false });
  useMarginStore.getState().reset();
  useMarginStore.setState({ drafts: {}, promptExtras: {}, savedComposers: {} });
  useUndoneSuggestions.setState({ ids: {} });
  vi.clearAllMocks();
});

afterEach(() => {
  mockRevisionConfig.stepMs = 700;
  mockRevisionConfig.acceptDelayMs = 0;
  mockRevisionConfig.patchDelayMs = 0;
});

describe('typing while the copilot writes the section (routed, MSW-backed)', () => {
  it('typing while an accept is in flight keeps the typed text out of the server and offers the choice', async () => {
    const user = userEvent.setup();
    await openSource();
    const card = await pendingSuggestion(user);
    const accepted = serverText();
    // Longer than the 800 ms autosave debounce: the debounce fires while the POST is in flight.
    mockRevisionConfig.acceptDelayMs = 1300;
    const io = recordWrites();

    await user.click(within(card).getByRole('button', { name: 'Accept' }));
    // The POST is in flight: type a character now, and ask for a save by hand as well.
    type('X');
    editorView().focus();
    await user.keyboard('{Control>}s{/Control}');
    await screen.findByText(/This section was changed elsewhere/, {}, LONG);
    // Give a (wrongly) released autosave time to show itself: its debounce is 800 ms.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    io.stop();

    // Exactly the accept, and no save of the old draft over it.
    expect(io.writes.filter((w) => w.startsWith('PATCH'))).toEqual([]);
    expect(io.writes.filter((w) => w.includes('/accept'))).toHaveLength(1);
    expect(serverText()).not.toBe(accepted);
    expect(serverText()).not.toContain('X');
    // The suggestion's text is on the server; the typed draft is intact in the editor.
    expect(serverText()).toContain('As requested');
    expect(editorText()).toMatch(/^X/);
    expect(editorText()).not.toContain('As requested');

    // Load the other version: the accepted text lands, the typed character is dropped by choice.
    await user.click(screen.getByRole('button', { name: 'Load the other version' }));
    await waitFor(() => expect(editorText()).toContain('As requested'), LONG);
    expect(editorText()).not.toMatch(/^X/);
  }, 60000);

  it('Keep mine, after typing during an accept, saves the draft on top of the other version with its hash', async () => {
    const user = userEvent.setup();
    await openSource();
    const card = await pendingSuggestion(user);
    mockRevisionConfig.acceptDelayMs = 300;
    await user.click(within(card).getByRole('button', { name: 'Accept' }));
    type('X');
    await screen.findByText(/This section was changed elsewhere/, {}, LONG);
    const io = recordWrites();
    await user.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(serverText()).toMatch(/^X/), LONG);
    io.stop();
    // A deliberate overwrite, based on the accepted text's hash: accepted by the server, no conflict.
    const patch = io.bodies.find((b) => b.key.startsWith('PATCH'));
    expect(patch?.body['expectedContentHash']).toMatch(/^[0-9a-f]{64}$/);
    expect(screen.queryByText(/This section was changed elsewhere/)).not.toBeInTheDocument();
  }, 60000);

  it('typing while an Undo is in flight is not overwritten either', async () => {
    const user = userEvent.setup();
    await openSource();
    const original = serverText();
    const card = await pendingSuggestion(user);
    await user.click(within(card).getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith('Suggestion applied', expect.anything()),
    );
    await waitFor(() => expect(editorText()).toContain('As requested'), LONG);
    const action = (toasts.success.mock.calls[0]![1] as { action: { onClick: () => void } }).action;

    mockRevisionConfig.patchDelayMs = 400;
    const io = recordWrites();
    act(() => action.onClick());
    type('Y');
    await screen.findByText(/This section was changed elsewhere/, {}, LONG);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    io.stop();

    // Only the undo's own PATCH (the restore) was sent; the draft with Y was not saved over it.
    const patches = io.bodies.filter((b) => b.key.startsWith('PATCH'));
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body['contentMarkdown']).toBe(original);
    expect(serverText()).toBe(original);
    expect(editorText()).toMatch(/^Y/);
  }, 60000);
});

describe('writes the copilot must refuse to make over text the person is not looking at (routed)', () => {
  it('Accept is blocked, with the reason shown, while the "changed elsewhere" notice is up', async () => {
    const user = userEvent.setup();
    await openSource();
    const card = await pendingSuggestion(user);
    // Someone else saved; the person types, the save is refused, the notice appears.
    db.outlineNodes.set(NODE_ID, {
      ...db.outlineNodes.get(NODE_ID)!,
      contentMarkdown: `${serverText()}\n\nElsewhere.`,
    });
    type('MINE ');
    await screen.findAllByText(/This section was changed elsewhere/, {}, LONG);
    const io = recordWrites();
    const accept = within(card).getByRole('button', { name: 'Accept' });
    expect(accept).toBeDisabled();
    expect(
      within(card).getByText(/Choose Keep mine or Load the other version first/),
    ).toBeVisible();
    await user.click(accept);
    io.stop();
    expect(io.writes).toEqual([]);
    expect(editorText()).toMatch(/^MINE /);
  }, 60000);

  it('Accept does not go through after a failed save: the draft stays unsaved and the card says so', async () => {
    const user = userEvent.setup();
    const view = await openSource();
    const card = await pendingSuggestion(user);
    server.use(
      http.patch('*/api/v1/projects/:projectId/outline/:nodeId', () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Server error', status: 500, instance: '/x' },
          { status: 500 },
        ),
      ),
    );
    type('MINE ');
    // The autosave fails (its debounce is 800 ms).
    await waitFor(() => expect(screen.getByText('Error saving')).toBeInTheDocument(), LONG);
    const io = recordWrites();
    await user.click(within(card).getByRole('button', { name: 'Accept' }));
    const alert = await within(card).findByRole('alert');
    io.stop();
    expect(alert).toHaveTextContent(/could not be saved first, so nothing was applied/);
    expect(io.writes.filter((w) => w.includes('/accept'))).toEqual([]);
    expect(editorText()).toMatch(/^MINE /);
    // Unmounting retries the failed save once more: let it fail here, not in the next test.
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }, 60000);

  it('a double click on Accept sends one accept', async () => {
    const user = userEvent.setup();
    await openSource();
    const card = await pendingSuggestion(user);
    mockRevisionConfig.acceptDelayMs = 300;
    const io = recordWrites();
    const accept = within(card).getByRole('button', { name: 'Accept' });
    await user.dblClick(accept);
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith('Suggestion applied', expect.anything()),
    );
    io.stop();
    expect(io.writes.filter((w) => w.includes('/accept'))).toHaveLength(1);
  }, 60000);
});

describe('what Undo does to the threads (routed)', () => {
  it('restores the text, reopens the thread the accept resolved, and says it is the text that was restored', async () => {
    const user = userEvent.setup();
    const node = db.outlineNodes.get(NODE_ID)!;
    const from = node.contentMarkdown.indexOf(SENTENCE);
    db.comments.set('seed', {
      id: 'seed',
      projectId: node.projectId,
      nodeId: node.id,
      kind: 'comment',
      authorId: 'someone',
      authorName: 'Grace',
      anchor: makeAnchor(node.contentMarkdown, from, from + SENTENCE.length),
      status: 'open',
      threadId: 'seed',
      parentId: null,
      bodyMarkdown: 'Can you expand this?',
      payload: {},
      createdAt: '2026-08-16T09:30:00Z',
      updatedAt: '2026-08-16T09:30:00Z',
      editedAt: null,
    });
    await openSource();
    await user.click(await screen.findByRole('button', { name: 'Send to Copilot' }, LONG));
    const card = await screen.findByRole('region', { name: /^Comment by Grace/ }, LONG);
    await within(card).findByText('Ready to review', {}, LONG);
    await user.click(within(card).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(db.comments.get('seed')!.status).toBe('resolved'), LONG);
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith('Suggestion applied', expect.anything()),
    );
    const action = (toasts.success.mock.calls[0]![1] as { action: { onClick: () => void } }).action;
    act(() => action.onClick());
    await waitFor(() => expect(db.comments.get('seed')!.status).toBe('open'), LONG);
    expect(toasts.success).toHaveBeenCalledWith(
      'Text restored',
      expect.objectContaining({
        description: expect.stringMatching(/stays marked accepted.*open again/),
      }),
    );
    const suggestion = [...db.comments.values()].find((row) => row.kind === 'suggestion')!;
    expect(suggestion.status).toBe('accepted');
    expect(useUndoneSuggestions.getState().ids[suggestion.id]).toBe(true);
    expect(serverText()).toBe(node.contentMarkdown);
  }, 60000);
});

describe('a suggestion inside a thread survives a save (routed)', () => {
  it('stays pending, with its actions, after an autosave re-anchors the thread', async () => {
    const user = userEvent.setup();
    const node = db.outlineNodes.get(NODE_ID)!;
    const from = node.contentMarkdown.indexOf(SENTENCE);
    db.comments.set('seed', {
      id: 'seed',
      projectId: node.projectId,
      nodeId: node.id,
      kind: 'comment',
      authorId: 'someone',
      authorName: 'Grace',
      anchor: makeAnchor(node.contentMarkdown, from, from + SENTENCE.length),
      status: 'open',
      threadId: 'seed',
      parentId: null,
      bodyMarkdown: 'Shorter?',
      payload: {},
      createdAt: '2026-08-16T09:30:00Z',
      updatedAt: '2026-08-16T09:30:00Z',
      editedAt: null,
    });
    await openSource();
    await user.click(await screen.findByRole('button', { name: 'Send to Copilot' }, LONG));
    const card = await screen.findByRole('region', { name: /^Comment by Grace/ }, LONG);
    await within(card).findByText('Ready to review', {}, LONG);

    const io = recordWrites();
    type('Z');
    await waitFor(() => expect(io.writes.some((w) => w.startsWith('PATCH'))).toBe(true), LONG);
    io.stop();
    // The comments are fetched again after the save: the suggestion's own status was not overwritten.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const suggestion = [...db.comments.values()].find((row) => row.kind === 'suggestion')!;
    expect(suggestion.status).toBe('pending');
    const again = await screen.findByRole('region', { name: /^Comment by Grace/ });
    expect(within(again).getByRole('button', { name: 'Accept' })).toBeInTheDocument();
  }, 60000);
});

describe('the margin does not re-render its cards while typing (routed)', () => {
  it('typing in the editor leaves the cards alone: the card context is stable', async () => {
    const user = userEvent.setup();
    const node = db.outlineNodes.get(NODE_ID)!;
    for (let i = 0; i < 6; i += 1) {
      const text = node.contentMarkdown;
      const at = text.indexOf('policy', i * 20);
      db.comments.set(`c${i}`, {
        id: `c${i}`,
        projectId: node.projectId,
        nodeId: node.id,
        kind: 'comment',
        authorId: 'someone',
        authorName: 'Grace',
        anchor: makeAnchor(text, at, at + 6),
        status: 'open',
        threadId: `c${i}`,
        parentId: null,
        bodyMarkdown: `note ${i}`,
        payload: {},
        createdAt: `2026-08-16T09:3${i}:00Z`,
        updatedAt: '2026-08-16T09:30:00Z',
        editedAt: null,
      });
    }
    let renders = 0;
    const Original = MARGIN_CARD_KINDS.comment.Body;
    MARGIN_CARD_KINDS.comment.Body = function Counting(props) {
      renders += 1;
      return <Original {...props} />;
    };
    try {
      await openSource();
      await waitFor(
        () => expect(screen.getAllByRole('region', { name: /^Comment by/ })).toHaveLength(6),
        LONG,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const before = renders;
      for (const ch of 'typing in the middle of the text') {
        type(ch, 40);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      // 32 keystrokes: the cards (whose body does not depend on the text) rendered at most a few more times,
      // not once per keystroke per card.
      expect(renders - before).toBeLessThanOrEqual(6 * 3);
      void user;
    } finally {
      MARGIN_CARD_KINDS.comment.Body = Original;
    }
  }, 60000);
});

describe('the prompt draft survives the sheet closing (routed, 1024 px)', () => {
  it('text and options are still there after a press on the editor closed the side sheet', async () => {
    const user = userEvent.setup();
    setViewportWidth(1024);
    renderRouterApp(NODE_URL);
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull(), LONG);
    await user.click(await screen.findByRole('button', { name: 'Copilot' }));
    const box = await screen.findByRole('textbox', { name: 'Instruction for the copilot' });
    await user.type(box, 'half written');
    await user.click(screen.getByRole('button', { name: 'cite sources' }));
    // A press on the editor closes the narrow side sheet.
    await user.click(screen.getByRole('region', { name: 'Manuscript' }));
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Margin' })).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: 'Copilot' }));
    const again = await screen.findByRole('textbox', { name: 'Instruction for the copilot' });
    expect(again).toHaveValue('half written');
    expect(screen.getByRole('button', { name: 'cite sources' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  }, 60000);
});
