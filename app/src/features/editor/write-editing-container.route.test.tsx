import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '@/stores/editor-store';
import { renderRouterApp } from '@/test/router-test-utils';

// One test per file for routed studio tests that mount the manuscript chunk: see
// `manuscript-sheet-readonly.route.test.tsx`.
const LONG = { timeout: 10000 };

beforeEach(() => useEditorStore.setState({ view: 'write' }));

describe('Studio editor pane (routed) — a container node in the Write view', () => {
  it('shows what it has, read-only, and offers no editor (text is written per leaf section)', async () => {
    renderRouterApp('/p/book-reinforcement-learning?node=rl-ch-1');
    expect(
      await screen.findByRole('heading', { level: 1, name: /Markov Decision Processes/ }, LONG),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Source' })).toBeEnabled());
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(document.querySelector('.md-editor')).toBeNull();
  }, 30000);
});
