import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import type { ModelList } from '@/api/types';
import { server } from '@/mocks/server';
import { renderWithProviders } from '@/test/component-test-utils';

import { ModelSelect } from './model-select';

describe('ModelSelect', () => {
  it('renders the discovered models as datalist options', async () => {
    renderWithProviders(<ModelSelect value="openai/gpt-5-mini" onChange={() => {}} id="model" />);

    const input = screen.getByRole('textbox');
    await waitFor(() => expect(input).toHaveAttribute('list'));

    const options = await screen.findAllByRole('option', { hidden: true });
    const values = options.map((option) => (option as HTMLOptionElement).value);
    expect(values).toContain('anthropic/claude-3.5-sonnet');
  });

  it('shows the current value even when it is not in the discovered list', async () => {
    renderWithProviders(
      <ModelSelect value="some-custom/not-in-catalog" onChange={() => {}} id="model" />,
    );

    const input = await screen.findByRole('textbox');
    expect(input).toHaveValue('some-custom/not-in-catalog');
  });

  it('falls back to a plain text input when the discovery list is empty', async () => {
    server.use(
      http.get('*/api/v1/system/models', () =>
        HttpResponse.json({ items: [], warning: 'endpoint unreachable' } satisfies ModelList),
      ),
    );

    renderWithProviders(<ModelSelect value="openai/gpt-5-mini" onChange={() => {}} id="model" />);

    const input = await screen.findByRole('textbox');
    // No datalist to fall back on - still a perfectly usable free-text field.
    expect(input).not.toHaveAttribute('list');
    expect(input).toHaveValue('openai/gpt-5-mini');
  });

  it('calls onChange as the user types', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<ModelSelect value="" onChange={onChange} id="model" />);

    const input = await screen.findByRole('textbox');
    await user.type(input, 'x');

    expect(onChange).toHaveBeenCalledWith('x');
  });
});
