import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { NodeCountBadges } from './node-count-badges';

describe('NodeCountBadges', () => {
  it('renders nothing for a node with no open comments or pending suggestions', () => {
    const { container } = render(
      <NodeCountBadges node={{ openCommentCount: 0, pendingSuggestionCount: 0 }} />,
    );
    expect(container).toBeEmptyDOMElement();
    const missing = render(<NodeCountBadges node={{}} />);
    expect(missing.container).toBeEmptyDOMElement();
  });

  it('labels each badge for assistive tech, singular and plural', () => {
    render(<NodeCountBadges node={{ openCommentCount: 3, pendingSuggestionCount: 1 }} />);
    expect(screen.getByRole('img', { name: '3 open comments' })).toHaveTextContent('3');
    expect(screen.getByRole('img', { name: '1 pending suggestion' })).toHaveTextContent('1');
  });

  it('shows only the kind that has a count', () => {
    render(<NodeCountBadges node={{ openCommentCount: 1 }} />);
    expect(screen.getByRole('img', { name: '1 open comment' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /suggestion/ })).not.toBeInTheDocument();
  });
});
