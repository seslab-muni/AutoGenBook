import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeAnchor } from '@/features/editor/lib/anchors';
import { sha256Hex } from '@/lib/content-hash';
import { seedReviewDemo } from '@/mocks/fixtures';
import { db, mockRevisionConfig } from '@/mocks/db';
import { server } from '@/mocks/server';
import { useEditorStore } from '@/stores/editor-store';
import { useMarginStore } from '@/features/editor/margin/margin-store';
import { useUiStore } from '@/stores/ui-store';
import { renderRouterApp } from '@/test/router-test-utils';

// The sheet is a lazily loaded chunk (CodeMirror + react-markdown + KaTeX).
const LONG = { timeout: 15000 };
// A project that never had a run: the copilot must work with no run behind it.
const NODE_URL = '/p/book-reinforcement-learning?node=rl-sec-1-1';
const NODE_ID = 'rl-sec-1-1';

function editorView(): EditorView {
  const dom = document.querySelector('.cm-editor') as HTMLElement | null;
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) throw new Error('CodeMirror view not mounted');
  return view;
}

function editorText(): string {
  return editorView().state.doc.toString();
}

/** Non-GET requests the app makes, as `METHOD path`, from now on. */
function recordWrites(): { writes: string[]; bodies: Map<string, unknown>; stop: () => void } {
  const writes: string[] = [];
  const bodies = new Map<string, unknown>();
  const listener = ({ request }: { request: Request }) => {
    if (request.method === 'GET') return;
    const key = `${request.method} ${new URL(request.url).pathname}`;
    writes.push(key);
    void request
      .clone()
      .json()
      .then((body) => bodies.set(key, body))
      .catch(() => {});
  };
  server.events.on('request:start', listener);
  return { writes, bodies, stop: () => server.events.removeListener('request:start', listener) };
}

async function openSource() {
  renderRouterApp(NODE_URL);
  await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull(), LONG);
  await screen.findByRole('complementary', { name: 'Margin' }, LONG);
}

function selectText(text: string) {
  const doc = editorText();
  const from = doc.indexOf(text);
  expect(from).toBeGreaterThan(-1);
  act(() => editorView().dispatch({ selection: { anchor: from, head: from + text.length } }));
}

/** Runs of the project under test (the other seeded project has one). */
function projectRuns() {
  return [...db.runs.values()].filter((run) => run.projectId === 'book-reinforcement-learning');
}

const SENTENCE = 'Because a finite MDP has only finitely many deterministic policies';

beforeEach(() => {
  mockRevisionConfig.stepMs = 5;
  useEditorStore.setState({ view: 'source' });
  useUiStore.setState({ marginOpen: true, rightOverlayOpen: false });
  useMarginStore.getState().reset();
});

afterEach(() => {
  mockRevisionConfig.stepMs = 700;
});

describe('copilot (routed, MSW-backed): select a sentence, Prompt…, get a diff card, accept', () => {
  it('works on a project with no run: the text changes after accepting, and nothing starts a run', async () => {
    const user = userEvent.setup();
    expect(projectRuns()).toHaveLength(0);
    await openSource();
    const before = editorText();
    selectText(SENTENCE);

    const bar = await screen.findByRole('toolbar', { name: 'Selection actions' });
    await user.click(within(bar).getByRole('button', { name: 'Prompt…' }));
    const instruction = await screen.findByRole('textbox', { name: 'Instruction for the copilot' });
    await waitFor(() => expect(instruction).toHaveFocus());
    expect(screen.getByText('Selection · 1 sentence')).toBeInTheDocument();
    await user.type(instruction, 'add a short proof');
    await user.click(screen.getByRole('button', { name: 'more proofs' }));

    const io = recordWrites();
    await user.keyboard('{Control>}{Enter}{/Control}');

    // The window gives way to a suggestion card, which works and then shows its diff.
    const card = await screen.findByRole('region', { name: /^Suggestion by/ }, LONG);
    expect(card).toHaveAttribute('data-kind', 'suggestion');
    await within(card).findByText('Ready to review', {}, LONG);
    expect(card.querySelector('ins')).toHaveTextContent(/Proof sketch/);
    // The outline row's badge counts it.
    expect(
      await screen.findByRole('img', { name: '1 pending suggestion' }, LONG),
    ).toBeInTheDocument();
    // The text is untouched until Accept.
    expect(editorText()).toBe(before);

    await user.click(within(card).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(editorText()).toContain('Proof sketch'), LONG);
    io.stop();

    // Exactly the revision and the accept: no run, and no autosave over the adopted text.
    expect(io.writes[0]).toBe(
      'POST /api/v1/projects/book-reinforcement-learning/outline/rl-sec-1-1/revisions',
    );
    expect(io.writes.filter((write) => write.startsWith('PATCH'))).toEqual([]);
    expect(io.writes.filter((write) => write.includes('/accept'))).toHaveLength(1);
    expect(projectRuns()).toHaveLength(0);
    expect(db.outlineNodes.get(NODE_ID)!.contentMarkdown).toBe(editorText());
    // The badge went away without a reload, and the card is hidden with the resolved ones.
    await waitFor(() =>
      expect(screen.queryByRole('img', { name: /pending suggestion/ })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('region', { name: /^Suggestion by/ })).not.toBeInTheDocument();
  }, 45000);
});

describe('copilot entry points (routed, MSW-backed)', () => {
  it('the header Copilot button opens the window at section scope', async () => {
    const user = userEvent.setup();
    await openSource();
    const io = recordWrites();
    await user.click(screen.getByRole('button', { name: 'Copilot' }));
    expect(await screen.findByText('Section §1.1')).toBeInTheDocument();
    const box = screen.getByRole('textbox', { name: 'Instruction for the copilot' });
    await waitFor(() => expect(box).toHaveFocus());
    await user.type(box, 'tighten the wording');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await screen.findByRole('region', { name: /^Suggestion by/ }, LONG);
    io.stop();
    const key = 'POST /api/v1/projects/book-reinforcement-learning/outline/rl-sec-1-1/revisions';
    await waitFor(() => expect(io.bodies.get(key)).toBeDefined());
    expect(io.bodies.get(key)).toMatchObject({
      verb: 'revise',
      scope: 'section',
      instruction: 'tighten the wording',
    });
    expect(io.bodies.get(key)).not.toHaveProperty('anchor');
    // Escape closed nothing else: the window gave way to the card and focus went to it.
    await waitFor(() =>
      expect(screen.getByRole('region', { name: /^Suggestion by/ })).toHaveFocus(),
    );
  }, 30000);

  it('Escape closes the window and gives focus back to the Copilot button', async () => {
    const user = userEvent.setup();
    await openSource();
    await user.click(screen.getByRole('button', { name: 'Copilot' }));
    await screen.findByRole('textbox', { name: 'Instruction for the copilot' });
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Prompt the copilot' })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copilot' })).toHaveFocus());
  }, 30000);

  it('a quick chip sends at once for the selected range, with that one parameter', async () => {
    const user = userEvent.setup();
    await openSource();
    selectText(SENTENCE);
    const io = recordWrites();
    await user.click(
      within(await screen.findByRole('toolbar', { name: 'Selection actions' })).getByRole(
        'button',
        {
          name: 'Shorter',
        },
      ),
    );
    const key = 'POST /api/v1/projects/book-reinforcement-learning/outline/rl-sec-1-1/revisions';
    await waitFor(() => expect(io.bodies.get(key)).toBeDefined());
    io.stop();
    expect(io.bodies.get(key)).toMatchObject({
      verb: 'revise',
      scope: 'range',
      instruction: '',
      anchor: { quote: SENTENCE },
    });
    // That one parameter and nothing else.
    expect((io.bodies.get(key) as { params: unknown }).params).toEqual({ shorter: true });
    // No window opened: the suggestion card is the answer.
    expect(screen.queryByRole('region', { name: 'Prompt the copilot' })).not.toBeInTheDocument();
    await screen.findByRole('region', { name: /^Suggestion by/ }, LONG);
  }, 30000);

  it('a comment that mentions @copilot is a prompt: the suggestion arrives in that thread', async () => {
    const user = userEvent.setup();
    await openSource();
    selectText(SENTENCE);
    const io = recordWrites();
    await user.click(
      within(await screen.findByRole('toolbar', { name: 'Selection actions' })).getByRole(
        'button',
        {
          name: 'Comment',
        },
      ),
    );
    await user.type(
      await screen.findByRole('textbox', { name: 'New comment' }),
      '@copilot please tighten this{Control>}{Enter}{/Control}',
    );
    const card = await screen.findByRole('region', { name: /^Comment by Ada Researcher on/ }, LONG);
    // The suggestion is a block inside the comment's own card, not a second card.
    await within(card).findByText('Ready to review', {}, LONG);
    expect(screen.queryByRole('region', { name: /^Suggestion by/ })).not.toBeInTheDocument();
    io.stop();

    const comment = [...db.comments.values()].find((row) => row.kind === 'comment')!;
    const key = 'POST /api/v1/projects/book-reinforcement-learning/outline/rl-sec-1-1/revisions';
    expect(io.bodies.get(key)).toMatchObject({
      verb: 'revise',
      scope: 'range',
      threadId: comment.id,
      instruction: '',
      anchor: { quote: SENTENCE },
    });
    const suggestion = [...db.comments.values()].find((row) => row.kind === 'suggestion')!;
    expect(suggestion.threadId).toBe(comment.id);
    expect(suggestion.parentId).toBe(comment.id);
    // The order matters: the comment exists before the revision refers to it.
    expect(io.writes.findIndex((w) => w.endsWith('/comments'))).toBeLessThan(
      io.writes.findIndex((w) => w.endsWith('/revisions')),
    );
  }, 45000);

  it('a comment without @copilot starts nothing', async () => {
    const user = userEvent.setup();
    await openSource();
    selectText(SENTENCE);
    const io = recordWrites();
    await user.click(
      within(await screen.findByRole('toolbar', { name: 'Selection actions' })).getByRole(
        'button',
        {
          name: 'Comment',
        },
      ),
    );
    await user.type(
      await screen.findByRole('textbox', { name: 'New comment' }),
      'just a note, copilot not involved{Control>}{Enter}{/Control}',
    );
    await screen.findByRole('region', { name: /^Comment by Ada Researcher on/ }, LONG);
    io.stop();
    expect(io.writes.some((write) => write.endsWith('/revisions'))).toBe(false);
  }, 30000);

  it('Send to Copilot on a thread answers in that thread without typing anything', async () => {
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
      bodyMarkdown: 'Can this be shorter?',
      payload: {},
      createdAt: '2026-08-16T09:30:00Z',
      updatedAt: '2026-08-16T09:30:00Z',
      editedAt: null,
    });
    await openSource();
    const io = recordWrites();
    await user.click(await screen.findByRole('button', { name: 'Send to Copilot' }, LONG));
    const key = 'POST /api/v1/projects/book-reinforcement-learning/outline/rl-sec-1-1/revisions';
    await waitFor(() => expect(io.bodies.get(key)).toBeDefined());
    io.stop();
    expect(io.bodies.get(key)).toMatchObject({
      scope: 'range',
      threadId: 'seed',
      anchor: { quote: SENTENCE },
    });
    const card = screen.getByRole('region', { name: /^Comment by Grace/ });
    await within(card).findByText('Ready to review', {}, LONG);
  }, 30000);
});

describe('suggestion lifecycle (routed, MSW-backed)', () => {
  async function ask(user: ReturnType<typeof userEvent.setup>, instruction: string) {
    await user.click(screen.getByRole('button', { name: 'Copilot' }));
    await user.type(
      await screen.findByRole('textbox', { name: 'Instruction for the copilot' }),
      instruction,
    );
    await user.keyboard('{Control>}{Enter}{/Control}');
  }

  it('cancel: a slow revision can be stopped; the badge and the card follow', async () => {
    const user = userEvent.setup();
    await openSource();
    await ask(user, 'slow please');
    const card = await screen.findByRole('region', { name: /^Suggestion by/ }, LONG);
    expect(
      await screen.findByRole('img', { name: '1 pending suggestion' }, LONG),
    ).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Cancel' }));
    await within(card).findByText(/You stopped this revision/, {}, LONG);
    await waitFor(() =>
      expect(screen.queryByRole('img', { name: /pending suggestion/ })).not.toBeInTheDocument(),
    );
    // A cancelled suggestion stays until it is dismissed.
    await user.click(within(card).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /^Suggestion by/ })).not.toBeInTheDocument(),
    );
  }, 45000);

  it('failure: the error code becomes words, with Try again and Dismiss', async () => {
    const user = userEvent.setup();
    await openSource();
    await ask(user, 'please fail');
    const card = await screen.findByRole('region', { name: /^Suggestion by/ }, LONG);
    await within(card).findByText(/language model took too long/, {}, LONG);
    expect(within(card).getByText('Failed')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('img', { name: /pending suggestion/ })).not.toBeInTheDocument(),
    );
    // Try again reopens the window with what was asked, and replaces the failed card.
    await user.click(within(card).getByRole('button', { name: 'Try again' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit the instruction…' }));
    const box = await screen.findByRole('textbox', { name: 'Instruction for the copilot' });
    expect(box).toHaveValue('please fail');
    await user.clear(box);
    await user.type(box, 'now it works{Control>}{Enter}{/Control}');
    const ready = await screen.findByText('Ready to review', {}, LONG);
    expect(ready).toBeInTheDocument();
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
  }, 45000);

  it('reject: the badge goes away and the text stays as it was', async () => {
    const user = userEvent.setup();
    await openSource();
    const before = editorText();
    await ask(user, 'add something');
    const card = await screen.findByRole('region', { name: /^Suggestion by/ }, LONG);
    await within(card).findByText('Ready to review', {}, LONG);
    await user.click(within(card).getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /^Suggestion by/ })).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.queryByRole('img', { name: /pending suggestion/ })).not.toBeInTheDocument(),
    );
    expect(editorText()).toBe(before);
  }, 45000);

  it('a section revision refused for an empty section says so in the window', async () => {
    const user = userEvent.setup();
    const node = db.outlineNodes.get(NODE_ID)!;
    db.outlineNodes.set(NODE_ID, { ...node, contentMarkdown: '   ' });
    await openSource();
    await ask(user, 'write it');
    const alert = await screen.findByRole('alert', {}, LONG);
    expect(alert).toHaveTextContent(/nothing to revise/i);
    // The window is still there with the text, not a toast.
    expect(screen.getByRole('textbox', { name: 'Instruction for the copilot' })).toHaveValue(
      'write it',
    );
  }, 30000);
});

describe('accepting with unsaved edits (routed, MSW-backed)', () => {
  it('saves the edit first, then accepts against the saved text, keeping both', async () => {
    const user = userEvent.setup();
    await openSource();
    await user.click(screen.getByRole('button', { name: 'Copilot' }));
    await user.type(
      await screen.findByRole('textbox', { name: 'Instruction for the copilot' }),
      'extend it{Control>}{Enter}{/Control}',
    );
    const card = await screen.findByRole('region', { name: /^Suggestion by/ }, LONG);
    await within(card).findByText('Ready to review', {}, LONG);

    // Type into the first line: unsaved when Accept is pressed.
    act(() => editorView().dispatch({ changes: { from: 0, insert: 'NOTE ' } }));
    const io = recordWrites();
    await user.click(within(card).getByRole('button', { name: 'Accept' }));
    // The accept's own text arrives in the editor, with the typed edit kept.
    await waitFor(() => expect(editorText()).toContain('As requested'), LONG);
    expect(io.writes.some((w) => w.includes('/accept'))).toBe(true);
    io.stop();
    // The edit was saved before the accept (a PATCH, then the POST), and nothing was overwritten.
    const patch = io.writes.findIndex((w) => w.startsWith('PATCH'));
    const accept = io.writes.findIndex((w) => w.includes('/accept'));
    expect(patch).toBeGreaterThanOrEqual(0);
    expect(patch).toBeLessThan(accept);
    expect(io.writes.filter((w) => w.startsWith('PATCH'))).toHaveLength(1);
    expect(db.outlineNodes.get(NODE_ID)!.contentMarkdown).toBe(editorText());
    expect(editorText()).toContain('NOTE ');
    expect(editorText()).not.toBe(`NOTE ${db.outlineNodes.get(NODE_ID)!.contentMarkdown}`);
  }, 45000);
});

describe('expectedContentHash (routed, MSW-backed)', () => {
  it('goes with every autosave, each one the hash of what the previous save left', async () => {
    await openSource();
    const original = db.outlineNodes.get(NODE_ID)!.contentMarkdown;
    const bodies: { contentMarkdown?: string; expectedContentHash?: string }[] = [];
    const listener = ({ request }: { request: Request }) => {
      if (request.method === 'PATCH') {
        void request
          .clone()
          .json()
          .then((body) => bodies.push(body as (typeof bodies)[number]));
      }
    };
    server.events.on('request:start', listener);

    act(() => editorView().dispatch({ changes: { from: 0, insert: 'A' } }));
    await waitFor(() => expect(bodies).toHaveLength(1), { timeout: 8000 });
    act(() => editorView().dispatch({ changes: { from: 0, insert: 'B' } }));
    await waitFor(() => expect(bodies).toHaveLength(2), { timeout: 8000 });
    server.events.removeListener('request:start', listener);

    expect(bodies[0]!.expectedContentHash).toBe(await sha256Hex(original));
    expect(bodies[1]!.expectedContentHash).toBe(await sha256Hex(bodies[0]!.contentMarkdown!));
    expect(db.outlineNodes.get(NODE_ID)!.contentMarkdown).toBe(bodies[1]!.contentMarkdown);
  }, 30000);

  it('a content conflict opens the "changed elsewhere" notice and never overwrites the other version', async () => {
    const user = userEvent.setup();
    await openSource();
    const other = `${db.outlineNodes.get(NODE_ID)!.contentMarkdown}\n\nAdded by someone else.`;
    // Another editor saved after this tab loaded the section.
    db.outlineNodes.set(NODE_ID, { ...db.outlineNodes.get(NODE_ID)!, contentMarkdown: other });

    act(() => editorView().dispatch({ changes: { from: 0, insert: 'MINE ' } }));
    const notice = await screen.findByText(
      /This section was changed elsewhere/,
      {},
      { timeout: 12000 },
    );
    expect(notice.closest('[role="status"]')).toBeInTheDocument();
    // The refused save wrote nothing: the other version is still what the server holds.
    expect(db.outlineNodes.get(NODE_ID)!.contentMarkdown).toBe(other);
    // The draft is kept.
    expect(editorText()).toMatch(/^MINE /);

    // Keep mine: the next save is based on the other version's hash and now succeeds.
    await user.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(
      () => expect(db.outlineNodes.get(NODE_ID)!.contentMarkdown).toMatch(/^MINE /),
      LONG,
    );
    expect(screen.queryByText(/This section was changed elsewhere/)).not.toBeInTheDocument();
  }, 45000);

  it('"Load the other version" replaces the draft and saves nothing', async () => {
    const user = userEvent.setup();
    await openSource();
    const other = `${db.outlineNodes.get(NODE_ID)!.contentMarkdown}\n\nAdded by someone else.`;
    db.outlineNodes.set(NODE_ID, { ...db.outlineNodes.get(NODE_ID)!, contentMarkdown: other });
    act(() => editorView().dispatch({ changes: { from: 0, insert: 'MINE ' } }));
    await screen.findByText(/This section was changed elsewhere/, {}, { timeout: 12000 });
    await user.click(screen.getByRole('button', { name: 'Load the other version' }));
    await waitFor(() => expect(editorText()).toBe(other), LONG);
    expect(db.outlineNodes.get(NODE_ID)!.contentMarkdown).toBe(other);
  }, 45000);
});

describe('review cards in the margin (routed, MSW-backed)', () => {
  it('shows the verdict strip and the issue cards, and Fix with Copilot starts a revision for that issue', async () => {
    const user = userEvent.setup();
    seedReviewDemo();
    renderRouterApp('/p/book-consensus-quantum-2026?node=sec-1-1');
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull(), LONG);
    const strip = await screen.findByRole('region', { name: 'Review summary' }, LONG);
    expect(within(strip).getByText('Needs revision')).toBeInTheDocument();
    expect(within(strip).getByText('2 major · 2 minor')).toBeInTheDocument();

    const anchored = await screen.findByRole(
      'region',
      { name: /^Review issue, major Coverage/ },
      LONG,
    );
    expect(within(anchored).getByText('Required fix')).toBeInTheDocument();
    const io = recordWrites();
    await user.click(within(anchored).getByRole('button', { name: 'Fix with Copilot' }));
    const key = 'POST /api/v1/projects/book-consensus-quantum-2026/outline/sec-1-1/revisions';
    await waitFor(() => expect(io.bodies.get(key)).toBeDefined());
    io.stop();
    const issue = [...db.comments.values()].find(
      (row) => row.kind === 'review' && (row.payload as { type?: string }).type === 'coverage',
    )!;
    expect(io.bodies.get(key)).toMatchObject({
      verb: 'revise',
      scope: 'range',
      instruction: '',
      anchor: { quote: 'Every correct process eventually decides on some value' },
      params: { fixIssueIds: [issue.id] },
    });
    expect(io.bodies.get(key)).not.toHaveProperty('threadId');
  }, 45000);

  it('Dismiss resolves an issue and the open counts follow; Show resolved brings it back', async () => {
    const user = userEvent.setup();
    seedReviewDemo();
    renderRouterApp('/p/book-consensus-quantum-2026?node=sec-1-1');
    const card = await screen.findByRole(
      'region',
      { name: /^Review issue, minor Terminology/ },
      LONG,
    );
    await user.click(within(card).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: /^Review issue, minor Terminology/ }),
      ).not.toBeInTheDocument(),
    );
    expect(await screen.findByText('2 major · 1 minor')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Show resolved \(1\)/ }));
    const back = await screen.findByRole('region', { name: /^Review issue, minor Terminology/ });
    expect(within(back).getByText('Dismissed')).toBeInTheDocument();
    await user.click(within(back).getByRole('button', { name: 'Reopen' }));
    expect(await screen.findByText('2 major · 2 minor')).toBeInTheDocument();
  }, 45000);

  it('shows OK to keep with No issues found for a clean review', async () => {
    seedReviewDemo();
    renderRouterApp('/p/book-consensus-quantum-2026?node=sec-1-2');
    const strip = await screen.findByRole('region', { name: 'Review summary' }, LONG);
    expect(within(strip).getByText('OK to keep')).toBeInTheDocument();
    expect(within(strip).getByText('No issues found')).toBeInTheDocument();
  }, 30000);

  it('shows no strip for a section that was never reviewed', async () => {
    renderRouterApp(NODE_URL);
    await screen.findByRole('complementary', { name: 'Margin' }, LONG);
    expect(screen.queryByRole('region', { name: 'Review summary' })).not.toBeInTheDocument();
  }, 30000);
});

describe('the legacy right-pane drawer is gone (routed)', () => {
  it('an old ?tab= link still opens the studio on the margin, with no Copilot/Review switch', async () => {
    renderRouterApp(`${NODE_URL}&tab=review`);
    await screen.findByRole('complementary', { name: 'Margin' }, LONG);
    expect(screen.queryByRole('radio', { name: 'Copilot' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Copilot' })).not.toBeInTheDocument();
    // The margin's own filter is the only Review control left.
    expect(screen.getByRole('radio', { name: 'Review' })).toBeInTheDocument();
  }, 30000);
});

describe('copilot in the Write view (routed, MSW-backed)', () => {
  it('select a sentence, Prompt…, accept: the rendered text changes', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ view: 'write' });
    renderRouterApp(NODE_URL);
    await screen.findByRole('complementary', { name: 'Margin' }, LONG);
    const target = await waitFor(() => {
      const el = [...document.querySelectorAll('[data-src-start]')].find((node) =>
        node.textContent?.includes('Because a finite MDP'),
      );
      if (!el) throw new Error('not rendered yet');
      return el;
    }, LONG);
    const textNode = target.firstChild as Text;
    const at = textNode.data.indexOf('Because a finite MDP');
    act(() => {
      const range = document.createRange();
      range.setStart(textNode, at);
      range.setEnd(textNode, at + 'Because a finite MDP'.length);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    const bar = await screen.findByRole('toolbar', { name: 'Selection actions' }, LONG);
    await user.click(within(bar).getByRole('button', { name: 'Prompt…' }));
    await user.type(
      await screen.findByRole('textbox', { name: 'Instruction for the copilot' }),
      'add an example{Control>}{Enter}{/Control}',
    );
    const card = await screen.findByRole('region', { name: /^Suggestion by/ }, LONG);
    await within(card).findByText('Ready to review', {}, LONG);
    await user.click(within(card).getByRole('button', { name: 'Accept' }));
    await waitFor(
      () =>
        expect(screen.getByRole('region', { name: 'Manuscript' })).toHaveTextContent(
          /As requested/,
        ),
      LONG,
    );
    expect(db.outlineNodes.get(NODE_ID)!.contentMarkdown).toContain('As requested');
  }, 45000);
});
