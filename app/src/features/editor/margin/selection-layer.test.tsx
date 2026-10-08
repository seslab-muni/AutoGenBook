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
  copilotActions = false,
  onPrompt,
  onChip,
}: {
  text: string;
  enabled?: boolean;
  onComment?: (a: unknown) => void;
  onFocusThread?: (id: string) => void;
  highlights?: { id: string; kind: string; start: number; end: number; hidden: boolean }[];
  copilotActions?: boolean;
  onPrompt?: (a: unknown) => void;
  onChip?: (chip: string, a: unknown) => void;
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
        copilotActions={copilotActions}
        onPrompt={onPrompt}
        onChip={onChip}
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

  describe('copilot entry points', () => {
    it('Prompt… and a chip hand over the selection as an anchor, trimmed, and dismiss the bar', async () => {
      const user = userEvent.setup();
      const onPrompt = vi.fn();
      const onChip = vi.fn();
      render(
        <Harness text="  hello 𝒫 world  " copilotActions onPrompt={onPrompt} onChip={onChip} />,
      );
      select(0, 17);
      await user.click(await screen.findByRole('button', { name: 'Prompt…' }));
      // Code points: the quote and its offsets count 𝒫 once.
      expect(onPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ quote: 'hello 𝒫 world', start: 2, end: 15 }),
      );
      expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();

      select(0, 16);
      await user.click(await screen.findByRole('button', { name: 'Add proof' }));
      expect(onChip).toHaveBeenCalledWith(
        'Add proof',
        expect.objectContaining({ quote: 'hello 𝒫 world' }),
      );
    });

    it('Ctrl+Alt+P prompts about the selection, and says what to do without one', async () => {
      const user = userEvent.setup();
      const onPrompt = vi.fn();
      render(<Harness text="hello world" copilotActions onPrompt={onPrompt} />);
      select(3, 3);
      screen.getByTestId('pane').focus();
      await user.keyboard('{Control>}{Alt>}p{/Alt}{/Control}');
      expect(onPrompt).not.toHaveBeenCalled();
      select(0, 5);
      await screen.findByRole('toolbar');
      await user.keyboard('{Control>}{Alt>}p{/Alt}{/Control}');
      expect(onPrompt).toHaveBeenCalledWith(expect.objectContaining({ quote: 'hello' }));
    });

    it('does nothing for Ctrl+Alt+P when the copilot is off', async () => {
      const user = userEvent.setup();
      const onPrompt = vi.fn();
      render(<Harness text="hello world" copilotActions={false} onPrompt={onPrompt} />);
      select(0, 5);
      await screen.findByRole('toolbar');
      screen.getByTestId('pane').focus();
      await user.keyboard('{Control>}{Alt>}p{/Alt}{/Control}');
      expect(onPrompt).not.toHaveBeenCalled();
    });

    it('refuses to prompt about a passage that is too long', async () => {
      const user = userEvent.setup();
      const onPrompt = vi.fn();
      render(<Harness text={'x'.repeat(20_001)} copilotActions onPrompt={onPrompt} />);
      select(0, 20_001);
      await user.click(await screen.findByRole('button', { name: 'Prompt…' }));
      expect(onPrompt).not.toHaveBeenCalled();
    });
  });
});
