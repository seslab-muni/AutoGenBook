import { describe, expect, it, vi } from 'vitest';

import { useEditorSelectionStore } from './editor-selection-store';

describe('editor selection store', () => {
  it('does not notify subscribers when the selection did not change', () => {
    const listener = vi.fn();
    const unsubscribe = useEditorSelectionStore.subscribe(listener);
    const { setSelection } = useEditorSelectionStore.getState();

    setSelection({ from: 1, to: 2, line: 1, column: 3 });
    setSelection({ from: 1, to: 2, line: 1, column: 3 });
    expect(listener).toHaveBeenCalledTimes(1);

    setSelection({ from: 1, to: 3, line: 1, column: 4 });
    expect(listener).toHaveBeenCalledTimes(2);

    setSelection(null);
    setSelection(null);
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });
});
