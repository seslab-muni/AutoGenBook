import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@/stores/editor-store';
import { renderRouterApp } from '@/test/router-test-utils';

// One test per file for routed studio tests that mount the manuscript chunk: see
// `manuscript-sheet-readonly.route.test.tsx`.
const LONG = { timeout: 10000 };

/** The editor chunk is its own module: `loads` counts every time anything asks for it. */
const control = vi.hoisted(() => ({ loads: 0 }));
vi.mock('@/features/editor/wysiwyg/markdown-editor', async (importOriginal) => {
  control.loads += 1;
  return importOriginal();
});

beforeEach(() => {
  control.loads = 0;
  vi.stubEnv('VITE_WRITE_EDITING', '0');
  useEditorStore.setState({ view: 'write' });
});
afterEach(() => vi.unstubAllEnvs());

describe('Studio editor pane (routed) — VITE_WRITE_EDITING=0', () => {
  it('is the read-only renderer it was before the editor existed, and never asks for the editor chunk', async () => {
    renderRouterApp('/p/book-reinforcement-learning?node=rl-sec-1-1');
    expect(await screen.findByText(/The policy improvement/, {}, LONG)).toBeInTheDocument();
    // Long enough for an upgrade to have happened if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(document.querySelector('.md-editor')).toBeNull();
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
    expect(document.querySelector('[data-write-pending]')).toBeNull();
    expect(control.loads).toBe(0);
    // Source is the way to edit, and it is there.
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Source' })).toBeEnabled());
  }, 30000);
});
