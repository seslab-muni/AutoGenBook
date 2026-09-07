import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Run } from '@/api/types';
import { RunCostSummary } from './run-cost-summary';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    projectId: 'project-1',
    kind: 'full',
    status: 'succeeded',
    options: {},
    baseRunId: null,
    targetNodeId: null,
    exitCode: 0,
    error: null,
    totalTokens: 128_450,
    totalCostUsd: 1.823,
    resumable: true,
    queuedAt: '2026-09-07T10:00:00Z',
    startedAt: '2026-09-07T10:00:05Z',
    finishedAt: '2026-09-07T10:04:35Z',
    ...overrides,
  };
}

describe('RunCostSummary', () => {
  it('formats duration/tokens/cost for a finished run using run-format helpers', () => {
    render(<RunCostSummary run={makeRun()} />);

    expect(screen.getByText('4:30')).toBeInTheDocument();
    expect(screen.getByText('128,450 tokens')).toBeInTheDocument();
    expect(screen.getByText('$1.82')).toBeInTheDocument();
  });

  it('shows placeholders for a run that never started', () => {
    render(
      <RunCostSummary
        run={makeRun({
          status: 'cancelled',
          totalTokens: null,
          totalCostUsd: null,
          startedAt: null,
          finishedAt: null,
        })}
      />,
    );

    const dashes = screen.getAllByText('—');
    expect(dashes).toHaveLength(3);
  });
});
