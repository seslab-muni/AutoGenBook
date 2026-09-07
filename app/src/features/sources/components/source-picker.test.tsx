import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { FakeXhr } from '@/test/fake-xhr';

import { SourcePicker } from './source-picker';
import type { PendingSource } from '@/features/sources/lib/pending-source';
import { toSourceCreate } from '@/features/sources/lib/pending-source';

function Harness({ createXhr }: { createXhr: () => XMLHttpRequest }) {
  const [value, setValue] = useState<PendingSource[]>([]);
  return (
    <TooltipProvider>
      <SourcePicker value={value} onChange={setValue} createXhr={createXhr} />
      <output data-testid="pending-count">{value.length}</output>
    </TooltipProvider>
  );
}

describe('SourcePicker', () => {
  it('adds an uploaded eligible file to the pending list with an inferred type', async () => {
    const user = userEvent.setup();
    let fake!: FakeXhr;
    render(<Harness createXhr={() => (fake = new FakeXhr()) as unknown as XMLHttpRequest} />);

    await user.upload(
      screen.getByLabelText('Upload files'),
      new File(['# notes'], 'Lecture_Notes.md', { type: 'text/markdown' }),
    );
    fake.respond(201, { id: 'file-1', filename: 'Lecture_Notes.md', kbEligible: true });

    await screen.findByText('Lecture_Notes.md');
    expect(screen.getByText('Markdown')).toBeInTheDocument();
    expect(screen.getByTestId('pending-count')).toHaveTextContent('1');
  });

  it('drops a pending source from the list on remove', async () => {
    const user = userEvent.setup();
    let fake!: FakeXhr;
    render(<Harness createXhr={() => (fake = new FakeXhr()) as unknown as XMLHttpRequest} />);

    await user.upload(
      screen.getByLabelText('Upload files'),
      new File(['data'], 'dataset.txt', { type: 'text/plain' }),
    );
    fake.respond(201, { id: 'file-2', filename: 'dataset.txt', kbEligible: true });
    await screen.findByText('dataset.txt');

    await user.click(screen.getByRole('button', { name: /remove dataset.txt/i }));
    expect(screen.getByTestId('pending-count')).toHaveTextContent('0');
  });
});

describe('toSourceCreate', () => {
  it('trims blank authors/year rather than sending empty strings', () => {
    const pending: PendingSource[] = [
      { fileId: 'f1', filename: 'a.pdf', sizeBytes: 10, type: 'pdf', authors: '  ', year: '' },
    ];
    expect(toSourceCreate(pending)).toEqual([{ fileId: 'f1', type: 'pdf' }]);
  });

  it('includes trimmed authors/year when present', () => {
    const pending: PendingSource[] = [
      {
        fileId: 'f1',
        filename: 'a.pdf',
        sizeBytes: 10,
        type: 'pdf',
        authors: ' Ada Lovelace ',
        year: '1843',
      },
    ];
    expect(toSourceCreate(pending)).toEqual([
      { fileId: 'f1', type: 'pdf', authors: 'Ada Lovelace', year: '1843' },
    ]);
  });
});
