import { useEffect } from 'react';

import {
  isBackwardSelection,
  sourceSelectionFromRange,
} from '@/features/editor/lib/dom-source-selection';
import { selectionInfo } from '@/features/editor/lib/selection-info';
import { useEditorSelectionStore } from '@/stores/editor-selection-store';

/**
 * Publishes the Write view's text selection to the editor selection store, as the Markdown
 * source range it maps to (`sourceSelectionFromRange`), so the status bar's `Ln, Col` readout and
 * the selection toolbar work there like in Source. A selection outside `region` is not ours and
 * is left alone; one inside it that maps to nothing clears the store.
 */
export function useWriteSelection(region: HTMLElement | null, text: string, enabled: boolean) {
  const setSelection = useEditorSelectionStore((state) => state.setSelection);

  useEffect(() => {
    if (!enabled || !region) return undefined;
    let frame: number | null = null;
    const publish = () => {
      frame = null;
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!region.contains(range.commonAncestorContainer)) return;
      const mapped = sourceSelectionFromRange(region, range, text, isBackwardSelection(selection));
      setSelection(mapped ? selectionInfo(text, mapped.from, mapped.to, mapped.head) : null);
    };
    const onChange = () => {
      if (frame === null) frame = requestAnimationFrame(publish);
    };
    document.addEventListener('selectionchange', onChange);
    return () => {
      document.removeEventListener('selectionchange', onChange);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [region, text, enabled, setSelection]);
}
