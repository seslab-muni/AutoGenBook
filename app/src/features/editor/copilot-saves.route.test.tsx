import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from '@codemirror/view';
import { delay, http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { projectKeys } from '@/api/queries/keys';
import { useMarginStore } from '@/features/editor/margin/margin-store';
import { useUndoneSuggestions } from '@/features/editor/margin/use-suggestion-actions';
import { db, mockRevisionConfig } from '@/mocks/db';
import { server } from '@/mocks/server';
import { useEditorStore } from '@/stores/editor-store';
import { useUiStore } from '@/stores/ui-store';
import { renderRouterApp } from '@/test/router-test-utils';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), message: vi.fn() }));
vi.mock('sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('sonner')>()),
  toast: toasts,
}));

const LONG = { timeout: 15000 };
const PROJECT = 'book-reinforcement-learning';
const NODE_ID = 'rl-sec-1-1';
const NODE_URL = `/p/${PROJECT}?node=${NODE_ID}`;

function editorView(): EditorView {
  const dom = document.querySelector('.cm-editor') as HTMLElement | null;
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) throw new Error('CodeMirror view not mounted');
  return view;
}
const editorText = () => editorView().state.doc.toString();
const serverText = () => db.outlineNodes.get(NODE_ID)!.contentMarkdown;
const typeAt = (text: string, at: number) =>
  act(() =>
    editorView().dispatch({ changes: { from: at, insert: text }, userEvent: 'input.type' }),
  );
const typeAtEnd = (text: string) => typeAt(text, editorView().state.doc.length);

/** Requests from now on: `METHOD path` (and the PATCH bodies), in the order they were sent. */
function recordRequests() {
  const log: string[] = [];
  const patches: Record<string, unknown>[] = [];
  const listener = ({ request }: { request: Request }) => {
    const key = `${request.method} ${new URL(request.url).pathname.replace('/api/v1/projects/', '')}`;
    log.push(key);
    if (request.method === 'PATCH') {
      void request
        .clone()
        .json()
        .then((body) => patches.push(body as Record<string, unknown>));
    }
  };
  server.events.on('request:start', listener);
  return { log, patches, stop: () => server.events.removeListener('request:start', listener) };
}

async function openSource() {
  const view = renderRouterApp(NODE_URL);
  await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull(), LONG);
  await screen.findByRole('complementary', { name: 'Margin' }, LONG);
  return view;
}

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
  mockRevisionConfig.failPatch = false;
});

describe('a node read that overlaps a save (routed, MSW-backed)', () => {
  it('a GET that started during the save and answers after it does not put the old text back', async () => {
    const { queryClient } = await openSource();
    const before = queryClient.getQueryData(projectKeys.outlineNode(PROJECT, NODE_ID));
    expect(before).toBeTruthy();
    mockRevisionConfig.patchDelayMs = 1200;
    const io = recordRequests();

    typeAtEnd(' MINE1');
    // Wait for the save to be on the wire, then start a read that answers with the pre-save node,
    // after the save has finished (what an outline invalidation during a save does).
    await waitFor(() => expect(io.log.some((l) => l.startsWith('PATCH'))).toBe(true), LONG);
    server.use(
      http.get(`*/api/v1/projects/:projectId/outline/${NODE_ID}`, async () => {
        await delay(2200);
        return HttpResponse.json(before as never);
      }),
    );
    void queryClient.invalidateQueries({ queryKey: projectKeys.outlineNode(PROJECT, NODE_ID) });

    await waitFor(() => expect(serverText()).toContain('MINE1'), LONG);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    io.stop();

    // The editor still shows what was saved - not the old text - and nothing was flagged.
    expect(editorText()).toContain('MINE1');
    expect(screen.queryByText(/This section was changed elsewhere/)).not.toBeInTheDocument();

    // And the next edit is based on the saved text: no conflict.
    server.resetHandlers();
    mockRevisionConfig.patchDelayMs = 0;
    const second = recordRequests();
    typeAtEnd(' MINE2');
    await waitFor(() => expect(serverText()).toContain('MINE2'), LONG);
    second.stop();
    expect(screen.queryByText(/This section was changed elsewhere/)).not.toBeInTheDocument();
    expect(toasts.error).not.toHaveBeenCalled();
  }, 60000);
});

describe('leaving a section with work the server does not have (routed)', () => {
  async function conflicted() {
    const user = userEvent.setup();
    await openSource();
    // Someone else saves the section; the person types and the save is refused.
    db.outlineNodes.set(NODE_ID, {
      ...db.outlineNodes.get(NODE_ID)!,
      contentMarkdown: `${serverText()}\n\nElsewhere.`,
    });
    typeAt('MINE ', 0);
    await screen.findAllByText(/This section was changed elsewhere/, {}, LONG);
    return user;
  }

  it('after a refused save, picking another section asks first and Stay keeps the text', async () => {
    const user = await conflicted();
    // The refusal is explained by the notice, not by a second raw toast.
    expect(toasts.error).not.toHaveBeenCalled();
    const io = recordRequests();
    await user.click(
      await screen.findByRole('treeitem', { name: /Multi-Agent Value Factorization/i }, LONG),
    );
    const dialog = await screen.findByRole('alertdialog', undefined, LONG);
    expect(dialog).toHaveTextContent(/edits that are not saved/i);
    await user.click(within(dialog).getByRole('button', { name: 'Stay' }));
    expect(editorText()).toMatch(/^MINE /);
    expect(screen.getAllByText(/This section was changed elsewhere/).length).toBeGreaterThan(0);
    io.stop();
    expect(io.log.filter((l) => l.startsWith('PATCH'))).toEqual([]);
  }, 60000);

  it('Leave and discard moves on and sends nothing on the way out', async () => {
    const user = await conflicted();
    const io = recordRequests();
    await user.click(
      await screen.findByRole('treeitem', { name: /Multi-Agent Value Factorization/i }, LONG),
    );
    const dialog = await screen.findByRole('alertdialog', undefined, LONG);
    await user.click(within(dialog).getByRole('button', { name: 'Leave and discard' }));
    await waitFor(
      () =>
        expect(
          screen.getByRole('treeitem', { name: /Multi-Agent Value Factorization/i }),
        ).toHaveAttribute('aria-selected', 'true'),
      LONG,
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    io.stop();
    expect(io.log.filter((l) => l.startsWith('PATCH'))).toEqual([]);
    expect(toasts.error).not.toHaveBeenCalled();
  }, 60000);
});

describe('a save that fails (routed)', () => {
  it('says why inline, keeps the text, and does not also raise a raw toast', async () => {
    await openSource();
    mockRevisionConfig.failPatch = true;
    typeAtEnd(' MINE');
    const alert = await screen.findByRole('alert', { name: '' }, LONG).catch(() => null);
    expect(alert).not.toBeNull();
    await waitFor(
      () =>
        expect(
          screen
            .getAllByRole('alert')
            .some((el) => /could not be saved/i.test(el.textContent ?? '')),
        ).toBe(true),
      LONG,
    );
    expect(editorText()).toContain(' MINE');
    expect(toasts.error).not.toHaveBeenCalled();
    // Recovered: the next edit saves, and the message goes.
    mockRevisionConfig.failPatch = false;
    typeAtEnd('!');
    await waitFor(() => expect(serverText()).toContain(' MINE!'), LONG);
    await waitFor(
      () =>
        expect(
          screen
            .queryAllByRole('alert')
            .some((el) => /could not be saved/i.test(el.textContent ?? '')),
        ).toBe(false),
      LONG,
    );
  }, 60000);
});
