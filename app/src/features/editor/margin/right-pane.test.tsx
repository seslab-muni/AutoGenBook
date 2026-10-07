import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeRunEvents } from '@/api/sse';
import type { Project } from '@/api/types';
import { db } from '@/mocks/db';
import { useUiStore } from '@/stores/ui-store';
import { renderWithProviders } from '@/test/component-test-utils';

import { RightColumn } from './right-pane';

vi.mock('@/api/sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sse')>();
  return { ...actual, subscribeRunEvents: vi.fn(() => () => {}) };
});

const PROJECT_ID = 'book-consensus-quantum-2026';

function renderColumn(node = db.outlineNodes.get('sec-1-2')!) {
  const onMarginHost = vi.fn();
  renderWithProviders(
    <RightColumn
      projectId={PROJECT_ID}
      project={db.projects.get(PROJECT_ID)! as Project}
      node={node}
      tab="copilot"
      onTabChange={vi.fn()}
      onMarginHost={onMarginHost}
    />,
  );
  return { onMarginHost };
}

beforeEach(() => {
  vi.mocked(subscribeRunEvents).mockReturnValue(() => {});
  useUiStore.setState({ rightPane: 'margin', copilotOpen: true, rightOverlayOpen: false });
});

describe('right column', () => {
  it('defaults to the margin: hands out its slot and does not mount the legacy drawer', () => {
    const { onMarginHost } = renderColumn();
    expect(screen.getByRole('radio', { name: 'Margin' })).toBeChecked();
    expect(onMarginHost).toHaveBeenCalledWith(expect.any(HTMLElement));
    expect(screen.queryByRole('tab', { name: 'Copilot' })).not.toBeInTheDocument();
  });

  it('switches to the legacy Copilot/Review drawer and back, releasing the margin slot', async () => {
    const user = userEvent.setup();
    const { onMarginHost } = renderColumn();
    await user.click(screen.getByRole('radio', { name: 'Copilot' }));
    expect(await screen.findByRole('tab', { name: 'Review' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Citations' })).not.toBeInTheDocument();
    expect(useUiStore.getState().rightPane).toBe('copilot');
    await waitFor(() => expect(onMarginHost.mock.lastCall?.[0]).toBeNull());

    await user.click(screen.getByRole('radio', { name: 'Margin' }));
    expect(screen.queryByRole('tab', { name: 'Review' })).not.toBeInTheDocument();
    expect(onMarginHost.mock.lastCall?.[0]).toBeInstanceOf(HTMLElement);
  });

  it('shows a hint instead of a slot while no section is selected', () => {
    const onMarginHost = vi.fn();
    renderWithProviders(
      <RightColumn
        projectId={PROJECT_ID}
        project={db.projects.get(PROJECT_ID)! as Project}
        node={null}
        tab="copilot"
        onTabChange={vi.fn()}
        onMarginHost={onMarginHost}
      />,
    );
    expect(screen.getByText('Select a section to see its comments.')).toBeInTheDocument();
  });

  it('hides the pane from its own button', async () => {
    const user = userEvent.setup();
    renderColumn();
    await user.click(screen.getByRole('button', { name: 'Close right pane' }));
    expect(useUiStore.getState().copilotOpen).toBe(false);
  });
});
