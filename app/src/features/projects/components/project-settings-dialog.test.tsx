import userEvent from '@testing-library/user-event';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useUiStore } from '@/stores/ui-store';
import { renderRouterApp } from '@/test/router-test-utils';

afterEach(() => {
  useUiStore.setState({ activeModal: null });
});

// Longer per-test timeout throughout: these mount /p/book-consensus-quantum-2026's full studio
// shell, whose outline pane (issue #19) now renders the fixture's whole 9-node tree — under the
// full suite's parallel jsdom load that can occasionally edge past the 5s default.
describe('ProjectSettingsDialog', () => {
  it(
    'edits and saves project metadata',
    async () => {
      const user = userEvent.setup();
      renderRouterApp('/p/book-consensus-quantum-2026');

      await screen.findByRole('heading', { name: /Distributed Consensus & Quantum Fault/i });
      await user.click(screen.getByRole('button', { name: /settings/i }));

      const titleInput = await screen.findByLabelText(/^title$/i);
      expect(titleInput).toHaveValue('Distributed Consensus & Quantum Fault Tolerance');

      await user.clear(titleInput);
      await user.type(titleInput, 'Consensus, Revised');
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      expect(
        await screen.findByRole('heading', { name: /^Consensus, Revised$/i, level: 1 }),
      ).toBeInTheDocument();
    },
    10000,
  );

  it(
    'deletes the project and returns to the hub',
    async () => {
      const user = userEvent.setup();
      renderRouterApp('/p/book-consensus-quantum-2026');

      await screen.findByRole('heading', { name: /Distributed Consensus & Quantum Fault/i });
      await user.click(screen.getByRole('button', { name: /settings/i }));
      await screen.findByLabelText(/^title$/i);

      await user.click(screen.getByRole('button', { name: /^delete$/i }));
      await user.click(await screen.findByRole('button', { name: /delete project/i }));

      expect(await screen.findByText(/AutoGenBook Studio/i, { selector: 'h1' })).toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { name: /Distributed Consensus & Quantum Fault/i }),
      ).not.toBeInTheDocument();
    },
    10000,
  );
});
