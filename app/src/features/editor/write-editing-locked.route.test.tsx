import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/mocks/db';
import { useEditorStore } from '@/stores/editor-store';
import { renderRouterApp } from '@/test/router-test-utils';

// One test per file for routed studio tests that mount the manuscript chunk: see
// `manuscript-sheet-readonly.route.test.tsx`.
const LONG = { timeout: 10000 };

beforeEach(() => useEditorStore.setState({ view: 'write' }));

describe('Studio editor pane (routed) — a content-locked section in the Write view', () => {
  it('stays editable: the lock only protects the text against runs', async () => {
    const node = db.outlineNodes.get('rl-sec-1-1')!;
    db.outlineNodes.set(node.id, { ...node, contentLocked: true });
    renderRouterApp('/p/book-reinforcement-learning?node=rl-sec-1-1');
    await waitFor(() => {
      if (!document.querySelector('.md-editor')) throw new Error('the editor is not mounted yet');
    }, LONG);
    expect(screen.getByRole('textbox', { name: 'Section text' })).toHaveAttribute(
      'contenteditable',
      'true',
    );
  }, 30000);
});
