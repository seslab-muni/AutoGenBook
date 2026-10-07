import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorSelectionStore } from '@/stores/editor-selection-store';
import { SelectionLayer } from './selection-layer';

function Harness({
  text,
  enabled = true,
  onComment = vi.fn(),
  onFocusThread = vi.fn(),
  highlights = [],
}: {
  text: string;
  enabled?: boolean;
  onComment?: (a: unknown) => void;
  onFocusThread?: (id: string) => void;
  highlights?: { id: string; kind: string; start: number; end: number; hidden: boolean }[];
}) {
  const pane = useRef<HTMLDivElement>(null);
  return (
    <div ref={pane} tabIndex={0} data-testid="pane">
      <SelectionLayer
        view="source"
        text={text}
        region={null}
        cmView={null}
        geometry={null}
        paneRef={pane}
        enabled={enabled}
        highlights={highlights}
        onComment={onComment}
        onFocusThread={onFocusThread}
        copilotActions={false}
      />
    </div>
  );
}

const select = (from: number, to: number) =>
  act(() => useEditorSelectionStore.getState().setSelection({ from, to, line: 1, column: 1 }));

beforeEach(() => useEditorSelectionStore.getState().setSelection(null));

describe('SelectionLayer', () => {
  it('shows the bar for a real selection, not for a whitespace-only one or when commenting is off', async () => {
    const text = '    word and more';
    const { rerender } = render(<Harness text={text} />);
    select(0, 4);
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    select(4, 8);
    expect(await screen.findByRole('toolbar', { name: 'Selection actions' })).toBeInTheDocument();
    rerender(<Harness text={text} enabled={false} />);
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });

  it('Ctrl+Alt+M comments on a selection (trimmed), and Escape dismisses the bar until the selection changes', async () => {
    const user = userEvent.setup();
    const onComment = vi.fn();
    render(<Harness text="  hello world  " onComment={onComment} />);
    select(0, 15);
    await screen.findByRole('toolbar');
    screen.getByTestId('pane').focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    select(0, 14);
    await screen.findByRole('toolbar');
    await user.keyboard('{Control>}{Alt>}m{/Alt}{/Control}');
    expect(onComment).toHaveBeenCalledWith(expect.objectContaining({ quote: 'hello world' }));
  });

  it('with only a caret inside a highlight, Ctrl+Alt+M focuses its card instead of commenting', async () => {
    const user = userEvent.setup();
    const onComment = vi.fn();
    const onFocusThread = vi.fn();
    render(
      <Harness
        text="some highlighted words here"
        onComment={onComment}
        onFocusThread={onFocusThread}
        highlights={[{ id: 'thread-1', kind: 'comment', start: 5, end: 16, hidden: false }]}
      />,
    );
    select(8, 8);
    screen.getByTestId('pane').focus();
    await user.keyboard('{Control>}{Alt>}m{/Alt}{/Control}');
    expect(onFocusThread).toHaveBeenCalledWith('thread-1');
    expect(onComment).not.toHaveBeenCalled();
  });
});
