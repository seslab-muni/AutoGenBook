import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { FakeXhr } from '@/test/fake-xhr';

import { UploadDropzone } from './upload-dropzone';

function makeFile(name = 'notes.md', content = 'hello world', type = 'text/markdown'): File {
  return new File([content], name, { type });
}

describe('UploadDropzone', () => {
  it('shows the other ingest methods as disabled with a "not available yet" hint', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <UploadDropzone onUploaded={vi.fn()} />
      </TooltipProvider>,
    );

    const arxivTab = screen.getByText('arXiv import');
    await user.hover(arxivTab);
    expect(await screen.findByText('Not available yet')).toBeInTheDocument();
  });

  it('calls onUploaded once an eligible file finishes uploading', async () => {
    const user = userEvent.setup();
    const onUploaded = vi.fn();
    let fake!: FakeXhr;
    render(
      <TooltipProvider>
        <UploadDropzone
          onUploaded={onUploaded}
          createXhr={() => (fake = new FakeXhr()) as unknown as XMLHttpRequest}
        />
      </TooltipProvider>,
    );

    await user.upload(screen.getByLabelText('Upload files'), makeFile());
    expect(await screen.findByText('notes.md')).toBeInTheDocument();

    fake.respond(201, { id: 'f1', filename: 'notes.md', kbEligible: true });
    await screen.findByText('Attached.');
    expect(onUploaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }));
  });

  it('warns instead of attaching when the server reports the file is not KB-eligible', async () => {
    const user = userEvent.setup();
    const onUploaded = vi.fn();
    let fake!: FakeXhr;
    render(
      <TooltipProvider>
        <UploadDropzone
          onUploaded={onUploaded}
          createXhr={() => (fake = new FakeXhr()) as unknown as XMLHttpRequest}
        />
      </TooltipProvider>,
    );

    await user.upload(
      screen.getByLabelText('Upload files'),
      makeFile('refs.bib', '@article{}', 'text/x-bibtex'),
    );
    fake.respond(201, { id: 'f2', filename: 'refs.bib', kbEligible: false });

    expect(await screen.findByText(/not eligible for RAG indexing/i)).toBeInTheDocument();
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('shows a size-limit message on a 413 response', async () => {
    const user = userEvent.setup();
    let fake!: FakeXhr;
    render(
      <TooltipProvider>
        <UploadDropzone
          onUploaded={vi.fn()}
          createXhr={() => (fake = new FakeXhr()) as unknown as XMLHttpRequest}
        />
      </TooltipProvider>,
    );

    await user.upload(
      screen.getByLabelText('Upload files'),
      makeFile('huge.pdf', 'x', 'application/pdf'),
    );
    fake.respond(413, {
      type: 'about:blank',
      title: 'Payload Too Large',
      status: 413,
      instance: '/api/v1/files',
    });

    expect(await screen.findByText(/exceeds the server upload size limit/i)).toBeInTheDocument();
  });

  it('cancels an in-flight upload', async () => {
    const user = userEvent.setup();
    let fake!: FakeXhr;
    render(
      <TooltipProvider>
        <UploadDropzone
          onUploaded={vi.fn()}
          createXhr={() => (fake = new FakeXhr()) as unknown as XMLHttpRequest}
        />
      </TooltipProvider>,
    );

    await user.upload(screen.getByLabelText('Upload files'), makeFile());
    await user.click(await screen.findByRole('button', { name: /cancel notes.md/i }));

    expect(fake.aborted).toBe(true);
    expect(await screen.findByText('Canceled.')).toBeInTheDocument();
  });
});
