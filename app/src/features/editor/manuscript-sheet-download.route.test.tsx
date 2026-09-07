import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderRouterApp } from '@/test/router-test-utils';

// Kept as the only `ManuscriptSheet`-mounting test in this file — see
// `manuscript-sheet-readonly.route.test.tsx`'s note on why a second mount in the same file hangs
// under jsdom+MSW (the "no artifact" case lives in `manuscript-sheet-no-download.route.test.tsx`).
const LONG = { timeout: 10000 };

describe('Studio editor pane (routed, MSW-backed) — section download', () => {
  it('offers a "Download section .md" link for a node the last run produced a section artifact for', async () => {
    renderRouterApp('/p/book-consensus-quantum-2026?node=sec-1-1');

    expect(
      await screen.findByRole(
        'heading',
        { level: 1, name: /Formal Safety and Liveness Definitions/ },
        LONG,
      ),
    ).toBeInTheDocument();

    const link = await screen.findByRole('link', { name: /download section \.md/i }, LONG);
    expect(link).toHaveAttribute(
      'href',
      expect.stringContaining(
        '/api/v1/files/book-consensus-quantum-2026-run-1-artifact-section-1-1/content',
      ),
    );
  }, 15000);
});
