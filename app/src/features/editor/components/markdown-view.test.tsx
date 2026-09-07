import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { RAGCitation } from '@/api/types';

import sampleSection from '@/features/editor/__fixtures__/sample-section.md?raw';
import { MarkdownView } from './markdown-view';

const CITATIONS: RAGCitation[] = [
  {
    id: 'castro_liskov_1999',
    sourceDoc: 'Castro_Liskov_PBFT_TOCS.pdf',
    pageNumber: 8,
    sectionSnippet: 'The system can tolerate up to f faulty nodes...',
    relevanceScore: 0.99,
    authorYear: 'Castro & Liskov, 1999',
  },
  {
    id: 'lamport_1982',
    sourceDoc: 'Lamport_1982_ByzantineGenerals.pdf',
    pageNumber: 4,
    sectionSnippet: 'A set of generals of the Byzantine army...',
    relevanceScore: 0.9,
    authorYear: 'Lamport et al., 1982',
  },
];

describe('MarkdownView', () => {
  it('renders headings, a GFM table, display math, a theorem callout and citation chips', () => {
    render(<MarkdownView markdown={sampleSection} citations={CITATIONS} />);

    expect(
      screen.getByRole('heading', { level: 1, name: /Byzantine Quorum Intersection/ }),
    ).toBeInTheDocument();

    // Display math ($$...$$) rendered by KaTeX in display mode.
    const displayMath = document.querySelector('.katex-display');
    expect(displayMath).not.toBeNull();
    // Inline math ($...$) rendered too.
    expect(document.querySelectorAll('.katex').length).toBeGreaterThan(1);

    // GFM table.
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Resilience bound' })).toBeInTheDocument();

    // Theorem callout: header shows the label, body no longer repeats the bold lead-in verbatim.
    expect(screen.getByText(/Theorem 3\.2 \(Quorum Intersection Bound\)/)).toBeInTheDocument();
    expect(screen.getByText(/Any two quorums of size at least/)).toBeInTheDocument();

    // Citation chips: one per occurrence, clickable, labeled from the matching RAGCitation.
    expect(screen.getAllByTestId('citation-chip-castro_liskov_1999').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('citation-chip-lamport_1982').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Castro & Liskov, 1999').length).toBeGreaterThan(0);

    // Fenced code block.
    expect(screen.getByText(/def quorum_size/)).toBeInTheDocument();
  });

  it('renders an unresolved citation as a muted, non-interactive chip', () => {
    render(<MarkdownView markdown="See \\cite{unknown_key} for details." citations={[]} />);
    const chip = screen.getByTestId('citation-chip-unknown_key');
    expect(chip).toBeDisabled();
  });

  it('calls onCitationClick with the citekey when a chip is clicked', async () => {
    const onCitationClick = vi.fn();
    render(
      <MarkdownView
        markdown="See [@lamport_1982] for details."
        citations={CITATIONS}
        onCitationClick={onCitationClick}
      />,
    );
    screen.getByTestId('citation-chip-lamport_1982').click();
    expect(onCitationClick).toHaveBeenCalledWith('lamport_1982');
  });

  it('sanitizes raw HTML, dropping a script tag while keeping the surrounding text', () => {
    render(
      <MarkdownView markdown={'Before\n\n<script>window.__pwned = true;</script>\n\nAfter'} />,
    );
    expect(screen.getByText('Before')).toBeInTheDocument();
    expect(screen.getByText('After')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it.each(['Lemma', 'Definition', 'Proof', 'Example'] as const)(
    'renders a %s callout the same way as a Theorem callout',
    (kind) => {
      render(
        <MarkdownView markdown={`> **${kind} 2:** Body text for the ${kind.toLowerCase()}.`} />,
      );
      expect(screen.getByText(`${kind} 2:`)).toBeInTheDocument();
      expect(
        screen.getByText(new RegExp(`Body text for the ${kind.toLowerCase()}`)),
      ).toBeInTheDocument();
    },
  );

  it('renders a plain blockquote (not starting with a callout keyword) unchanged', () => {
    render(<MarkdownView markdown="> Just a regular quote, not a theorem." />);
    const blockquote = document.querySelector('blockquote');
    expect(blockquote).not.toBeNull();
    expect(blockquote?.textContent?.trim()).toBe('Just a regular quote, not a theorem.');
  });

  it('matches a structural snapshot (headings, table rows, callout label, citation labels) for the CLI-style fixture', () => {
    render(<MarkdownView markdown={sampleSection} citations={CITATIONS} />);

    const summary = {
      headings: Array.from(document.querySelectorAll('h1,h2,h3')).map((el) => el.textContent),
      tableHeaderRow: Array.from(document.querySelectorAll('th')).map((el) => el.textContent),
      calloutLabel: document.querySelector('.border-indigo-600')?.querySelector(':scope > div')
        ?.textContent,
      citationLabels: Array.from(document.querySelectorAll('[data-testid^="citation-chip-"]')).map(
        (el) => el.textContent,
      ),
      displayMathCount: document.querySelectorAll('.katex-display').length,
    };

    expect(summary).toMatchSnapshot();
  });
});
