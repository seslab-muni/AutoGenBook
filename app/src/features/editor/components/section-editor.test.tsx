import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

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
});
