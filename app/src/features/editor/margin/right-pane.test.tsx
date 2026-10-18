import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/mocks/db';
import { useUiStore } from '@/stores/ui-store';
import { renderWithProviders } from '@/test/component-test-utils';

import { RightColumn } from './right-pane';

function renderColumn(node = db.outlineNodes.get('sec-1-2')!) {
  const onMarginHost = vi.fn();
  renderWithProviders(<RightColumn node={node} onMarginHost={onMarginHost} />);
  return { onMarginHost };
}

beforeEach(() => {
  useUiStore.setState({ marginOpen: true, rightOverlayOpen: false });
});

describe('right column', () => {
  it('is just the margin: hands out its slot, with no switch and no legacy drawer', () => {
    const { onMarginHost } = renderColumn();
    expect(onMarginHost).toHaveBeenCalledWith(expect.any(HTMLElement));
    expect(screen.queryByRole('radio', { name: 'Margin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Copilot' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('shows a hint instead of a slot while no section is selected', () => {
    renderWithProviders(<RightColumn node={null} onMarginHost={vi.fn()} />);
    expect(screen.getByText('Select a section to see its comments.')).toBeInTheDocument();
  });

  it('hides the pane from its own button', async () => {
    const user = userEvent.setup();
    renderColumn();
    await user.click(screen.getByRole('button', { name: 'Close right pane' }));
    expect(useUiStore.getState().marginOpen).toBe(false);
  });
});
