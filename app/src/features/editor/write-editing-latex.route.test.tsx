import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/mocks/db';
import { useEditorStore } from '@/stores/editor-store';
import { renderRouterApp } from '@/test/router-test-utils';

// One test per file for routed studio tests that mount the manuscript chunk: see
// `manuscript-sheet-readonly.route.test.tsx`.
const LONG = { timeout: 10000 };

beforeEach(() => useEditorStore.setState({ view: 'write' }));

describe('Studio editor pane (routed) — a LaTeX-only section in the Write view', () => {
  it('stays the read-only view (the server anchors and revises Markdown), with Source still usable', async () => {
    const node = db.outlineNodes.get('rl-sec-1-1')!;
    db.outlineNodes.set(node.id, {
      ...node,
      contentMarkdown: '',
      contentLatex: '\\section{Policy Iteration}\nGiven a policy.',
    });
    renderRouterApp('/p/book-reinforcement-learning?node=rl-sec-1-1');
    expect(await screen.findByText(/Given a policy/, {}, LONG)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(document.querySelector('.md-editor')).toBeNull();
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Source' })).toBeEnabled());
  }, 30000);
});
