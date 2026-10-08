import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@/stores/editor-store';
import { renderRouterApp } from '@/test/router-test-utils';

// One test per file for routed studio tests that mount the manuscript chunk: see
// `manuscript-sheet-readonly.route.test.tsx`.
const LONG = { timeout: 10000 };

beforeEach(() => useEditorStore.setState({ view: 'write' }));
afterEach(() => vi.unstubAllEnvs());

describe('Studio editor pane (routed) — VITE_WRITE_EDITING unset or 1', () => {
  it('is the editable Write view by default', async () => {
    vi.stubEnv('VITE_WRITE_EDITING', '1');
    renderRouterApp('/p/book-reinforcement-learning?node=rl-sec-1-1');
    expect(await screen.findByRole('textbox', { name: 'Section text' }, LONG)).toBeInTheDocument();
    await vi.waitFor(() => expect(document.querySelector('.md-editor')).not.toBeNull(), LONG);
    expect(document.querySelector('.md-editor')).toHaveAttribute('contenteditable', 'true');
  }, 30000);
});
