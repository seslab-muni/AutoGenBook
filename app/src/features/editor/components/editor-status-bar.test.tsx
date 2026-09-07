import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EditorStatusBar } from './editor-status-bar';

describe('EditorStatusBar', () => {
  it('shows the server word count and derived page estimate when not dirty', () => {
    render(
      <EditorStatusBar
        serverWords={640}
        draftWords={999}
        isDirty={false}
        equationCount={2}
        status="saved"
      />,
    );
    expect(screen.getByText('640 words')).toBeInTheDocument();
    expect(screen.getByText('≈ 2 pages')).toBeInTheDocument();
    expect(screen.getByText('2 equations')).toBeInTheDocument();
  });

  it('shows the live draft word count while dirty, not the stale server count', () => {
    render(
      <EditorStatusBar
        serverWords={640}
        draftWords={12}
        isDirty={true}
        equationCount={0}
        status="dirty"
      />,
    );
    expect(screen.getByText('12 words')).toBeInTheDocument();
    expect(screen.getByText('0 equations')).toBeInTheDocument();
  });

  it('shows a reviewer score badge when present', () => {
    render(
      <EditorStatusBar
        serverWords={100}
        draftWords={100}
        isDirty={false}
        equationCount={0}
        status="saved"
        reviewerScore={7.5}
      />,
    );
    expect(screen.getByText('Review 7.5')).toBeInTheDocument();
  });

  it('omits the reviewer badge when there is no score', () => {
    render(
      <EditorStatusBar
        serverWords={100}
        draftWords={100}
        isDirty={false}
        equationCount={0}
        status="saved"
      />,
    );
    expect(screen.queryByText(/^Review/)).not.toBeInTheDocument();
  });

  it('shows the save status', () => {
    render(
      <EditorStatusBar
        serverWords={0}
        draftWords={0}
        isDirty={false}
        equationCount={0}
        status="error"
      />,
    );
    expect(screen.getByText('Error saving')).toBeInTheDocument();
  });
});
