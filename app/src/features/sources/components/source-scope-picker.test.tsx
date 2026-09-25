import userEvent from '@testing-library/user-event';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Source } from '@/api/types';
import { renderWithProviders } from '@/test/component-test-utils';

import { SourceScopePicker } from './source-scope-picker';

function source(overrides: Partial<Source> & Pick<Source, 'id' | 'name'>): Source {
  return {
    fileId: `${overrides.id}-file`,
    sizeBytes: 1024,
    type: 'pdf',
    chunksCount: 10,
    status: 'indexed',
    uploadDate: '2026-01-01T00:00:00Z',
    authors: null,
    year: null,
    ...overrides,
  };
}

const SOURCES: Source[] = [
  source({
    id: 'golub',
    name: 'Golub_VanLoan.pdf',
    authors: 'Golub, Van Loan',
    year: '2013',
    chunksCount: 600,
  }),
  source({ id: 'notes', name: 'lecture-notes.md', type: 'md', chunksCount: 40 }),
  source({ id: 'bench', name: 'benchmarks.pptx', type: 'ppt', status: 'ready', chunksCount: null }),
];

function renderPicker(initialSelectedIds: string[] = [], onApply = vi.fn()) {
  renderWithProviders(
    <SourceScopePicker
      open
      onOpenChange={() => {}}
      node={{ sectionNumber: '2', title: 'Direct methods' }}
      sources={SOURCES}
      initialSelectedIds={initialSelectedIds}
      onApply={onApply}
    />,
  );
  return { dialog: screen.getByRole('dialog', { name: 'Choose sources' }), onApply };
}

describe('SourceScopePicker', () => {
  it('filters by search text (including authors) and by type chip', async () => {
    const user = userEvent.setup();
    const { dialog } = renderPicker();
    expect(within(dialog).getByText('Showing 3 of 3')).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('Search sources'), 'van loan');
    expect(within(dialog).getByText('Golub_VanLoan.pdf')).toBeInTheDocument();
    expect(within(dialog).queryByText('lecture-notes.md')).not.toBeInTheDocument();

    await user.clear(within(dialog).getByLabelText('Search sources'));
    await user.click(within(dialog).getByRole('button', { name: 'Markdown' }));
    expect(within(dialog).getByText('Showing 1 of 3')).toBeInTheDocument();
    expect(within(dialog).getByText('lecture-notes.md')).toBeInTheDocument();
  });

  it('disables Apply until something is selected, then applies the selection', async () => {
    const user = userEvent.setup();
    const { dialog, onApply } = renderPicker();
    const apply = within(dialog).getByRole('button', { name: 'Apply to §2' });
    expect(apply).toBeDisabled();
    expect(within(dialog).getByText('Nothing selected')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('checkbox', { name: 'Golub_VanLoan.pdf' }));
    expect(within(dialog).getByText('1 source selected')).toBeInTheDocument();
    expect(within(dialog).getByText(/600 of 640 indexed chunks/)).toBeInTheDocument();

    await user.click(apply);
    expect(onApply).toHaveBeenCalledWith(['golub']);
  });

  it('"Select all shown" / "Clear", and warns about selected sources that are not indexed', async () => {
    const user = userEvent.setup();
    const { dialog } = renderPicker(['golub']);
    expect(within(dialog).getByRole('checkbox', { name: 'Golub_VanLoan.pdf' })).toBeChecked();

    await user.click(within(dialog).getByRole('button', { name: 'Select all shown' }));
    expect(within(dialog).getByText('3 sources selected')).toBeInTheDocument();
    expect(within(dialog).getByText(/1 selected source is not indexed yet/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Clear' }));
    expect(within(dialog).getByText('Nothing selected')).toBeInTheDocument();
  });
});
