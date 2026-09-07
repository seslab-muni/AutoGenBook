import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderRouterApp } from '@/test/router-test-utils';

// Kept as the only `ManuscriptSheet`-mounting test in this file — see
// `manuscript-sheet-readonly.route.test.tsx`'s note on why a second mount in the same file hangs
// under jsdom+MSW.
const LONG = { timeout: 10000 };

describe('Studio editor pane (routed, MSW-backed) — section download absent', () => {
  it('shows no "Download section .md" link for a node the last run never produced a section artifact for', async () => {
    renderRouterApp('/p/book-consensus-quantum-2026?node=sec-1-2');

    expect(
      await screen.findByRole(
        'heading',
        { level: 1, name: /Byzantine Quorum Intersection & Threshold Bounds/ },
        LONG,
      ),
    ).toBeInTheDocument();

    expect(screen.queryByRole('link', { name: /download section \.md/i })).not.toBeInTheDocument();
  }, 15000);
});
