import userEvent from '@testing-library/user-event';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import type { RunArtifact } from '@/api/types';
import { db } from '@/mocks/db';
import { server } from '@/mocks/server';
import { renderWithProviders } from '@/test/component-test-utils';

import { ArtifactsList } from './artifacts-list';

const ARTIFACTS: RunArtifact[] = [
  {
    kind: 'markdown',
    relativePath: 'book.md',
    fileId: 'file-md',
    filename: 'book.md',
    sizeBytes: 2048,
    contentType: 'text/markdown',
  },
  {
    kind: 'bib',
    relativePath: 'refs.bib',
    fileId: 'file-bib',
    filename: 'refs.bib',
    sizeBytes: 512,
    contentType: 'text/x-bibtex',
  },
  {
    kind: 'log',
    relativePath: 'run.log',
    fileId: 'file-log',
    filename: 'run.log',
    sizeBytes: 128,
    contentType: 'text/plain',
  },
  {
    kind: 'llm_usage',
    relativePath: 'llm_usage.jsonl',
    fileId: 'file-usage',
    filename: 'llm_usage.jsonl',
    sizeBytes: 256,
    contentType: 'application/jsonl',
  },
  {
    kind: 'audit_report',
    relativePath: 'audit_report.json',
    fileId: 'file-audit',
    filename: 'audit_report.json',
    sizeBytes: 300,
    contentType: 'application/json',
  },
];

function registerFile(fileId: string, filename: string, contentType: string) {
  db.files.set(fileId, {
    id: fileId,
    filename,
    contentType,
    sizeBytes: 100,
    sha256: fileId,
    kind: 'artifact',
    kbEligible: false,
    createdAt: db.now(),
  });
}

function seedFiles() {
  for (const artifact of ARTIFACTS) {
    registerFile(artifact.fileId, artifact.filename, artifact.contentType);
  }
}

const LLM_USAGE_JSONL = [
  JSON.stringify({ label: 'draft-1', totalTokens: 500, totalCostUsd: 0.01 }),
  JSON.stringify({ label: 'draft-2', totalTokens: 1200, totalCostUsd: 0.03 }),
].join('\n');

const AUDIT_REPORT_JSON = JSON.stringify({
  doc_kind: 'book',
  counts_by_severity: { error: 1 },
  issues: [{ issue_type: 'unknown_cite_key', severity: 'error', message: 'bad cite' }],
});

function mockFileContent(fileId: string, body: string, contentType: string) {
  server.use(
    http.get(`*/api/v1/files/${fileId}/content`, () =>
      HttpResponse.text(body, { headers: { 'Content-Type': contentType } }),
    ),
  );
}

describe('ArtifactsList', () => {
  it('shows an empty state with no artifacts', () => {
    renderWithProviders(<ArtifactsList artifacts={[]} />);
    expect(screen.getByText('No artifacts yet')).toBeInTheDocument();
  });

  it('groups artifacts by kind with a download link per file', () => {
    seedFiles();
    renderWithProviders(<ArtifactsList artifacts={ARTIFACTS} />);

    // Group headings appear in the fixed `ARTIFACT_KIND_ORDER`, not fixture insertion order.
    const headings = screen.getAllByRole('heading', { level: 4 }).map((el) => el.textContent);
    expect(headings).toEqual(['Markdown', 'BibTeX', 'LLM usage', 'Audit report', 'Log']);

    const markdownLink = screen.getByText('book.md').closest('li');
    expect(markdownLink).not.toBeNull();
    expect(
      within(markdownLink as HTMLElement).getByRole('link', { name: /download/i }),
    ).toHaveAttribute('href', expect.stringContaining('/api/v1/files/file-md/content'));
  });

  it('summarizes llm_usage calls/tokens/cost from the JSONL content', async () => {
    seedFiles();
    mockFileContent('file-usage', LLM_USAGE_JSONL, 'application/jsonl');
    renderWithProviders(<ArtifactsList artifacts={ARTIFACTS} />);

    expect(await screen.findByText(/2 calls/)).toBeInTheDocument();
    expect(screen.getByText(/1,200 tokens/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.03/)).toBeInTheDocument();
  });

  it('expands the log viewer on demand', async () => {
    const user = userEvent.setup();
    seedFiles();
    mockFileContent('file-log', 'line one\nline two', 'text/plain');
    renderWithProviders(<ArtifactsList artifacts={ARTIFACTS} />);

    expect(screen.queryByText('line one')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /view log/i }));
    expect(await screen.findByText(/line one/)).toBeInTheDocument();
  });

  it('renders the audit report as an expandable JSON tree', async () => {
    const user = userEvent.setup();
    seedFiles();
    mockFileContent('file-audit', AUDIT_REPORT_JSON, 'application/json');
    renderWithProviders(<ArtifactsList artifacts={ARTIFACTS} />);

    await user.click(screen.getByRole('button', { name: /show findings/i }));
    expect(await screen.findByText('doc_kind')).toBeInTheDocument();
    expect(screen.getByText('"book"')).toBeInTheDocument();
  });
});
