import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import type { ModelList } from '@/api/types';
import { server } from '@/mocks/server';
import { renderWithProviders } from '@/test/component-test-utils';

import { ModelSelect } from './model-select';

describe('ModelSelect', () => {
  it('shows the current value on the trigger and lists discovered models once opened', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ModelSelect value="" onChange={() => {}} id="model" />);

    // Only the trigger button is mounted while the popover is closed.
    const trigger = screen.getByRole('combobox');
    await user.click(trigger);

    // Empty search text - every discovered model is listed, unfiltered.
    await waitFor(() =>
      expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(
        expect.arrayContaining(['Claude 3.5 Sonnet', 'GPT-5 mini']),
      ),
    );
  });

  it('shows the current value even when it is not in the discovered list', async () => {
    renderWithProviders(
      <ModelSelect value="some-custom/not-in-catalog" onChange={() => {}} id="model" />,
    );

    expect(screen.getByRole('combobox')).toHaveTextContent('some-custom/not-in-catalog');
  });

  it('shows the placeholder, not an empty list, when the discovery list is empty', async () => {
    server.use(
      http.get('*/api/v1/system/models', () =>
        HttpResponse.json({ items: [], warning: 'endpoint unreachable' } satisfies ModelList),
      ),
    );
    const user = userEvent.setup();

    renderWithProviders(<ModelSelect value="" onChange={() => {}} id="model" />);

    await user.click(screen.getByRole('combobox'));

    // Still a perfectly usable free-text search box - just no suggestions under it.
    const search = await screen.findByPlaceholderText('e.g. openai/gpt-5-mini');
    expect(search).toHaveValue('');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('calls onChange as the user types in the search box', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<ModelSelect value="" onChange={onChange} id="model" />);

    await user.click(screen.getByRole('combobox'));
    const search = await screen.findByPlaceholderText('e.g. openai/gpt-5-mini');
    await user.type(search, 'x');

    expect(onChange).toHaveBeenCalledWith('x');
  });

  it('calls onChange and closes the popover when a suggestion is picked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<ModelSelect value="" onChange={onChange} id="model" />);

    await user.click(screen.getByRole('combobox'));
    const option = await screen.findByRole('option', { name: /Claude 3\.5 Sonnet/i });
    await user.click(option);

    expect(onChange).toHaveBeenCalledWith('anthropic/claude-3.5-sonnet');
    await waitFor(() => expect(screen.queryByRole('option')).not.toBeInTheDocument());
  });
});
