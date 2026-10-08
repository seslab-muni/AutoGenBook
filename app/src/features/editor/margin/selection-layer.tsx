import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { EditorView } from '@codemirror/view';
import { toast } from 'sonner';

import { useWriteSelection } from '@/features/editor/hooks/use-write-selection';
import { CodePointIndex, makeAnchor, type Anchor } from '@/features/editor/lib/anchors';
import { trimRange } from '@/features/editor/lib/dom-source-selection';
import { useEditorSelectionStore } from '@/stores/editor-selection-store';
import type { MarginGeometry } from './geometry';
import { SelectionToolbar } from './selection-toolbar';

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface SelectionLayerProps {
  view: 'write' | 'source';
  /** The live draft (UTF-16 offsets index into it). */
  text: string;
  /** The scrolling text pane (Write) the DOM selection lives in. */
  region: HTMLElement | null;
  cmView: EditorView | null;
  geometry: MarginGeometry | null;
  /** The positioned pane the toolbar floats in; also where the shortcut is listened for. */
  paneRef: RefObject<HTMLDivElement | null>;
  /** Commenting on a range is possible (false for LaTeX-only sections). */
  enabled: boolean;
  /** Located ranges of the cards currently shown, for "caret inside a highlight" (UTF-16 offsets). */
  highlights: readonly { id: string; kind: string; start: number; end: number; hidden: boolean }[];
  onComment: (anchor: Anchor) => void;
  /** Focus the card of the highlight the caret is in. */
  onFocusThread: (id: string) => void;
  /** `Prompt…`: with the flag on and this supplied, the toolbar shows it. Gets the selected range. */
  onPrompt?: ((anchor: Anchor) => void) | undefined;
  /** A quick chip (`Add proof`, ...): likewise; sends at once for the selected range. */
  onChip?: ((chip: string, anchor: Anchor) => void) | undefined;
}

/**
 * Everything that follows the text selection, kept out of `ManuscriptSheet` on purpose: a
 * `selectionchange` re-renders only this component, never the sheet, so dragging a selection in the
 * rendered Markdown cannot disturb the DOM the selection lives in. Renders the floating toolbar
 * (hidden while the selection is blank, out of view, or dismissed with Escape) and handles the
 * `Ctrl+Alt+M` shortcut: with a selection it starts a comment; with only a caret inside a highlight
 * it moves keyboard focus to that highlight's card.
 */
export function SelectionLayer({
  view,
  text,
  region,
  cmView,
  geometry,
  paneRef,
  enabled,
  highlights,
  onComment,
  onFocusThread,
  onPrompt,
  onChip,
}: SelectionLayerProps) {
  const selection = useEditorSelectionStore((state) => state.selection);
  useWriteSelection(region, text, view === 'write');

  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  // The selection as a trimmed code-point range of the draft, or null when there is nothing worth commenting on.
  const range = useMemo(() => {
    if (!enabled || !selection || selection.from === selection.to) return null;
    const index = new CodePointIndex(text);
    const trimmed = trimRange(text, index.toUnit(selection.from), index.toUnit(selection.to));
    return trimmed ? { from: selection.from, to: selection.to, units: trimmed } : null;
  }, [enabled, selection, text]);
  const selectionKey = range ? `${view}:${range.from}:${range.to}` : null;
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [paneSize, setPaneSize] = useState({ width: 0, height: 0 });
  const visible = selectionKey !== null && selectionKey !== dismissedKey;

  useEffect(() => {
    const pane = paneRef.current;
    if (!visible || !pane || !selection) return undefined;
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const paneRect = pane.getBoundingClientRect();
      setPaneSize({ width: paneRect.width, height: paneRect.height });
      let found: Box | null = null;
      if (view === 'source' && cmView) {
        const index = new CodePointIndex(textRef.current);
        try {
          const start = cmView.coordsAtPos(index.toUnit(selection.from), 1);
          const end = cmView.coordsAtPos(index.toUnit(selection.to), -1);
          if (start && end) {
            found = { top: start.top, bottom: end.bottom, left: start.left, right: end.right };
          }
        } catch {
          found = null;
        }
      } else {
        const domSelection = document.getSelection();
        const rects =
          domSelection && domSelection.rangeCount > 0
            ? Array.from(domSelection.getRangeAt(0).getClientRects())
            : [];
        if (rects.length > 0) {
          const first = rects[0]!;
          const last = rects[rects.length - 1]!;
          found = { top: first.top, bottom: last.bottom, left: first.left, right: last.right };
        }
      }
      // Unmeasurable, or scrolled out of the text pane's view: no bar rather than one in the wrong place.
      if (!found && paneRect.width === 0 && paneRect.height === 0) {
        // No layout engine at all (jsdom): there is nothing to measure, show the bar at the pane's corner.
        setBox({ top: 8, bottom: 8, left: 8, right: 8 });
        return;
      }
      const scroller = (geometry?.scrollEl ?? pane).getBoundingClientRect();
      if (!found || found.bottom < scroller.top || found.top > scroller.bottom) {
        setBox(null);
        return;
      }
      setBox({
        top: found.top - paneRect.top,
        bottom: found.bottom - paneRect.top,
        left: found.left - paneRect.left,
        right: found.right - paneRect.left,
      });
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(measure);
    };
    schedule();
    const scroller = geometry?.scrollEl;
    scroller?.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      scroller?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [visible, selection, view, cmView, geometry, paneRef]);

  /** The selection as an anchor, or `null` (with a message) when it is too long to act on. */
  function selectedAnchor(verb: string): Anchor | null {
    if (!range) return null;
    const current = textRef.current;
    const index = new CodePointIndex(current);
    const from = index.toCp(range.units[0]);
    const to = index.toCp(range.units[1]);
    if (to - from > 20000) {
      toast.error(`Select a shorter passage to ${verb} (at most 20,000 characters).`);
      return null;
    }
    return makeAnchor(current, from, to);
  }

  function startComment() {
    const anchor = selectedAnchor('comment on');
    if (!anchor) return;
    setDismissedKey(selectionKey);
    onComment(anchor);
  }

  function startPrompt() {
    const anchor = selectedAnchor('revise');
    if (!anchor || !onPrompt) return;
    setDismissedKey(selectionKey);
    onPrompt(anchor);
  }

  function sendChip(chip: string) {
    const anchor = selectedAnchor('revise');
    if (!anchor || !onChip) return;
    setDismissedKey(selectionKey);
    onChip(chip, anchor);
  }

  // The latest handlers behind a ref: the pane listener is attached once.
  const handlersRef = useRef({
    startComment,
    startPrompt: onPrompt ? startPrompt : undefined,
    onFocusThread,
    highlights,
    selection,
    enabled,
    visible,
    selectionKey,
  });
  useEffect(() => {
    handlersRef.current = {
      startComment,
      startPrompt: onPrompt ? startPrompt : undefined,
      onFocusThread,
      highlights,
      selection,
      enabled,
      visible,
      selectionKey,
    };
  });
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const h = handlersRef.current;
      if (event.code === 'KeyM' && event.altKey && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (h.selection && h.selection.from !== h.selection.to) {
          h.startComment();
          return;
        }
        if (h.selection) {
          const unit = new CodePointIndex(textRef.current).toUnit(h.selection.from);
          const hit = h.highlights.find(
            (highlight) =>
              !highlight.hidden &&
              highlight.kind !== 'draft' &&
              highlight.start <= unit &&
              unit <= highlight.end,
          );
          if (hit) {
            h.onFocusThread(hit.id);
            return;
          }
        }
        toast.message(
          'Select the text to comment on, or put the caret inside a highlight to jump to its card.',
        );
      } else if (
        event.code === 'KeyP' &&
        event.altKey &&
        (event.ctrlKey || event.metaKey) &&
        h.startPrompt
      ) {
        event.preventDefault();
        if (h.selection && h.selection.from !== h.selection.to) h.startPrompt();
        else toast.message('Select the text to prompt the copilot about.');
      } else if (event.key === 'Escape' && h.visible && !event.defaultPrevented) {
        setDismissedKey(h.selectionKey);
      }
    };
    pane.addEventListener('keydown', onKeyDown);
    return () => pane.removeEventListener('keydown', onKeyDown);
  }, [paneRef]);

  if (!visible || !box) return null;
  return (
    <SelectionToolbar
      rect={box}
      containerWidth={paneSize.width}
      containerHeight={paneSize.height}
      onComment={startComment}
      onPrompt={onPrompt ? startPrompt : undefined}
      onChip={onChip ? sendChip : undefined}
    />
  );
}
