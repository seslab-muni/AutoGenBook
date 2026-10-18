import { act, render, screen } from '@testing-library/react';
import type { EditorView } from '@codemirror/view';
import { useCallback, useState } from 'react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { EditorSelection } from '@/stores/editor-selection-store';

import { SectionEditor } from './section-editor';

describe('SectionEditor', () => {
  it('renders the given value and calls onChange as the user types', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onFlush = vi.fn();
    render(<SectionEditor value="# Hello" onChange={onChange} onFlush={onFlush} />);

    const editor = document.querySelector('.cm-content');
    expect(editor).not.toBeNull();
    expect(editor?.textContent).toBe('# Hello');
    await user.click(editor!);
    await user.type(editor!, '!');

    expect(onChange).toHaveBeenCalled();
  });

  it('calls onFlush on blur', async () => {
    const user = userEvent.setup();
    const onFlush = vi.fn();
    render(
      <>
        <SectionEditor value="draft" onChange={vi.fn()} onFlush={onFlush} />
        <button type="button">elsewhere</button>
      </>,
    );

    const editor = document.querySelector('.cm-content')!;
    await user.click(editor);
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));

    expect(onFlush).toHaveBeenCalled();
  });

  it('is not editable when readOnly', () => {
    render(<SectionEditor value="locked" onChange={vi.fn()} onFlush={vi.fn()} readOnly />);
    const editor = document.querySelector('.cm-content');
    expect(editor).toHaveAttribute('aria-readonly', 'true');
  });

  it('reports the selection in code points, not UTF-16 units', () => {
    const seen: EditorSelection[] = [];
    let view: EditorView | undefined;
    render(
      <SectionEditor
        value={'a\u{1D516}b\nxy'}
        onChange={vi.fn()}
        onFlush={vi.fn()}
        onSelectionChange={(selection) => seen.push(selection)}
        onCreateEditor={(created) => {
          view = created;
        }}
      />,
    );
    expect(seen.at(-1)).toEqual({ from: 0, to: 0, line: 1, column: 1 });

    // After the astral letter: UTF-16 index 3, code point 2.
    act(() => view!.dispatch({ selection: { anchor: 3 } }));
    expect(seen.at(-1)).toEqual({ from: 2, to: 2, line: 1, column: 3 });

    // After "x" on line 2, with the selection starting at the document start.
    act(() => view!.dispatch({ selection: { anchor: 0, head: 6 } }));
    expect(seen.at(-1)).toEqual({ from: 0, to: 5, line: 2, column: 2 });
  });

  it('does not reconfigure CodeMirror when the parent re-renders around a caret move', () => {
    let view: EditorView | undefined;
    const onChange = vi.fn();
    const onFlush = vi.fn();
    const onSelectionChange = vi.fn();
    function Parent() {
      const [tick, setTick] = useState(0);
      const handleSelection = useCallback((selection: EditorSelection) => {
        onSelectionChange(selection);
        setTick((value) => value + 1);
      }, []);
      return (
        <SectionEditor
          value="some text"
          onChange={onChange}
          onFlush={onFlush}
          className={`render-${tick}`}
          onSelectionChange={handleSelection}
          onCreateEditor={(created) => {
            view = created;
          }}
        />
      );
    }
    render(<Parent />);
    const dispatch = vi.spyOn(view!, 'dispatch');

    act(() => view!.dispatch({ selection: { anchor: 4 } }));
    act(() => view!.dispatch({ selection: { anchor: 5 } }));

    // Only the two dispatches above — a reconfigure would add its own `dispatch` call.
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
