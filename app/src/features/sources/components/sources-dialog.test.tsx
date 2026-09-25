import userEvent from '@testing-library/user-event';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { db } from '@/mocks/db';
import { useUiStore } from '@/stores/ui-store';
import { renderWithProviders } from '@/test/component-test-utils';
import { FakeXhr } from '@/test/fake-xhr';

import { SourcesDialog } from './sources-dialog';

const PROJECT_ID = 'book-consensus-quantum-2026';

afterEach(() => {
  useUiStore.setState({ activeModal: null });
});

function openDialog(createXhr?: () => XMLHttpRequest) {
  useUiStore.setState({ activeModal: 'sources' });
  return renderWithProviders(
    <SourcesDialog projectId={PROJECT_ID} {...(createXhr ? { createXhr } : {})} />,
  );
}

/** The `<tr>` holding a source, found by its (unique) file name. */
function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest('tr');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

describe('SourcesDialog', () => {
  it("lists the project's sources with type, status, and citation count", async () => {
    openDialog();

    await screen.findByText('Lamport_1982_ByzantineGenerals.pdf');
    const row = rowOf('Lamport_1982_ByzantineGenerals.pdf');
    expect(within(row).getByText('PDF')).toBeInTheDocument();
    expect(within(row).getByText(/Indexed \(\d+ chunks\)/)).toBeInTheDocument();
    // One `ragCitations` entry points at this source in the fixture outline.
    expect(within(row).getByText('1')).toBeInTheDocument();
  });

  it('filters by search text', async () => {
    const user = userEvent.setup();
    openDialog();

    await screen.findByText('Lamport_1982_ByzantineGenerals.pdf');
    await user.type(screen.getByLabelText('Search sources'), 'castro');

    expect(screen.getByText('Castro_Liskov_PBFT_TOCS.pdf')).toBeInTheDocument();
    expect(screen.queryByText('Lamport_1982_ByzantineGenerals.pdf')).not.toBeInTheDocument();
  });

  it('filters by type from the rail, showing a per-type count', async () => {
    const user = userEvent.setup();
    openDialog();

    await screen.findByText('Lamport_1982_ByzantineGenerals.pdf');
    const slidesFilter = screen.getByRole('button', { name: /^Slides/ });
    expect(slidesFilter).toHaveTextContent('1');
    await user.click(slidesFilter);

    expect(slidesFilter).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('MIT_6.824_Distributed_Systems_Slides.pptx')).toBeInTheDocument();
    expect(screen.queryByText('Lamport_1982_ByzantineGenerals.pdf')).not.toBeInTheDocument();
  });

  it('sorts by name when the Source column header is clicked', async () => {
    const user = userEvent.setup();
    openDialog();

    await screen.findByText('Lamport_1982_ByzantineGenerals.pdf');
    await user.click(screen.getByRole('button', { name: 'Source' }));

    expect(screen.getByRole('columnheader', { name: 'Source' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    const [firstRow] = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(firstRow).toHaveTextContent('BFT_Surface_Code_Syndrome_Specs.md');
  });

  it("edits a source's metadata", async () => {
    const user = userEvent.setup();
    openDialog();

    await screen.findByText('Lamport_1982_ByzantineGenerals.pdf');
    await user.click(
      screen.getByRole('button', { name: /Lamport_1982_ByzantineGenerals.pdf actions/i }),
    );
    await user.click(await screen.findByRole('menuitem', { name: /edit metadata/i }));

    const yearInput = await screen.findByLabelText('Year');
    await user.clear(yearInput);
    await user.type(yearInput, '1982');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await screen.findByText('Leslie Lamport, Robert Shostak (1982)');
  });

  it('detaches a source after confirmation', async () => {
    const user = userEvent.setup();
    openDialog();

    await screen.findByText('Lamport_1982_ByzantineGenerals.pdf');
    await user.click(
      screen.getByRole('button', { name: /Lamport_1982_ByzantineGenerals.pdf actions/i }),
    );
    await user.click(await screen.findByRole('menuitem', { name: /detach/i }));
    await user.click(await screen.findByRole('button', { name: /^detach$/i }));

    await waitFor(() =>
      expect(screen.queryByText('Lamport_1982_ByzantineGenerals.pdf')).not.toBeInTheDocument(),
    );
  });

  it('detaches several selected sources at once', async () => {
    const user = userEvent.setup();
    openDialog();

    await screen.findByText('Lamport_1982_ByzantineGenerals.pdf');
    await user.click(screen.getByLabelText('Select Lamport_1982_ByzantineGenerals.pdf'));
    await user.click(screen.getByLabelText('Select Castro_Liskov_PBFT_TOCS.pdf'));
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^detach$/i }));
    const confirm = await screen.findByRole('alertdialog', { name: /detach 2 sources/i });
    await user.click(within(confirm).getByRole('button', { name: /^detach$/i }));

    await waitFor(() => {
      expect(screen.queryByText('Lamport_1982_ByzantineGenerals.pdf')).not.toBeInTheDocument();
      expect(screen.queryByText('Castro_Liskov_PBFT_TOCS.pdf')).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
  });

  it('attaches a newly uploaded eligible file as a source', async () => {
    const user = userEvent.setup();
    let fake!: FakeXhr;
    openDialog(() => (fake = new FakeXhr()) as unknown as XMLHttpRequest);

    await screen.findByText('Lamport_1982_ByzantineGenerals.pdf');
    await user.upload(
      screen.getByLabelText('Upload files'),
      new File(['# notes'], 'ExtraNotes.md', { type: 'text/markdown' }),
    );
    fake.respond(201, { id: 'new-file-1', filename: 'ExtraNotes.md', kbEligible: true });

    expect(await screen.findByText('ExtraNotes.md')).toBeInTheDocument();
  });

  it('shows which outline nodes select each source in the "Used in" column (issue #138)', async () => {
    const chapter = db.outlineNodes.get('ch-2')!;
    db.outlineNodes.set('ch-2', {
      ...chapter,
      sourceScope: 'selected',
      sourceIds: ['file-lamport-1982-source'],
    });
    openDialog();

    await screen.findByText('Lamport_1982_ByzantineGenerals.pdf');
    await waitFor(() =>
      expect(
        within(rowOf('Lamport_1982_ByzantineGenerals.pdf')).getByText('§2'),
      ).toBeInTheDocument(),
    );
    expect(within(rowOf('Castro_Liskov_PBFT_TOCS.pdf')).getByText('—')).toBeInTheDocument();
  });

  it("assigns selected sources to chapters, keeping a chapter's existing selection", async () => {
    const chapter = db.outlineNodes.get('ch-2')!;
    db.outlineNodes.set('ch-2', {
      ...chapter,
      sourceScope: 'selected',
      sourceIds: ['file-lamport-1982-source'],
    });
    const user = userEvent.setup();
    openDialog();

    await screen.findByText('Castro_Liskov_PBFT_TOCS.pdf');
    await user.click(screen.getByRole('checkbox', { name: 'Select Castro_Liskov_PBFT_TOCS.pdf' }));
    await user.click(screen.getByRole('button', { name: 'Assign to chapters…' }));

    const popover = await screen.findByRole('dialog', { name: 'Assign to chapters' });
    expect(within(popover).getByText('Add 1 source to…')).toBeInTheDocument();
    const assign = within(popover).getByRole('button', { name: 'Assign' });
    expect(assign).toBeDisabled();
    await user.click(within(popover).getByRole('checkbox', { name: /^§2 / }));
    await user.click(within(popover).getByRole('checkbox', { name: /^§3 / }));
    await user.click(assign);

    await waitFor(() =>
      expect(db.outlineNodes.get('ch-3')).toMatchObject({
        sourceScope: 'selected',
        sourceIds: ['file-castro-liskov-pbft-source'],
      }),
    );
    expect(db.outlineNodes.get('ch-2')?.sourceIds).toEqual([
      'file-lamport-1982-source',
      'file-castro-liskov-pbft-source',
    ]);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Assign to chapters' })).not.toBeInTheDocument(),
    );
  });
});
