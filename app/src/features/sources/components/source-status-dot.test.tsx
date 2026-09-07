import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';

import { SourceStatusDot } from './source-status-dot';

describe('SourceStatusDot', () => {
  it('renders "awaiting first run" for a freshly attached source', () => {
    render(
      <TooltipProvider>
        <SourceStatusDot source={{ status: 'ready', chunksCount: null }} />
      </TooltipProvider>,
    );
    expect(screen.getByText('Awaiting first run')).toBeInTheDocument();
  });

  it('renders the chunk count for an indexed source', () => {
    render(
      <TooltipProvider>
        <SourceStatusDot source={{ status: 'indexed', chunksCount: 48 }} />
      </TooltipProvider>,
    );
    expect(screen.getByText('Indexed (48 chunks)')).toBeInTheDocument();
  });

  it('renders "not indexed" for a source the last run failed to index', () => {
    render(
      <TooltipProvider>
        <SourceStatusDot source={{ status: 'error', chunksCount: null }} />
      </TooltipProvider>,
    );
    expect(screen.getByText('Not indexed')).toBeInTheDocument();
  });
});
