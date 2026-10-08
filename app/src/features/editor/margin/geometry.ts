import { EditorView } from '@codemirror/view';

import { appliedFor, onHighlightsApplied } from '@/features/editor/lib/write-highlights';

export interface AnchorMeasure {
  /** y of the anchor's first line, in the scroller's content coordinates (0 = top of its content). */
  y: number;
  /** The anchor has no rendered highlight in this view: `y` is that of the nearest positioned block. */
  approximate: boolean;
}

/** What the margin needs to know about the text pane, whichever view is showing. */
export interface MarginGeometry {
  /** The element that scrolls the text; the margin mirrors its scroll position. */
  scrollEl: HTMLElement;
  /** Reads only; anchors that cannot be placed at all are left out. */
  measure: (anchors: readonly { id: string; start: number }[]) => Map<string, AnchorMeasure>;
  /** Scrolls the anchor into view in the text pane. */
  reveal: (id: string, start: number) => void;
  /**
   * Lets the text pane scroll `px` further than its content, so cards stacked below the last line
   * stay reachable (and level with their text) at the end of the scroll range.
   */
  setExtraBottom: (px: number) => void;
  /** Calls `listener` when text may have moved without scrolling (resize, reflow, highlights painted). */
  subscribe: (listener: () => void) => () => void;
  /** Height of the content without the extra bottom space. */
  contentHeight: () => number;
  /** Current scroll position of the text pane. */
  scrollTop: () => number;
  /** Scrolls the text pane by `dy` pixels. */
  scrollBy: (dy: number) => void;
  /** The text pane's visible height. */
  viewportHeight: () => number;
}

function observe(targets: readonly Element[], listener: () => void): () => void {
  const observer = new ResizeObserver(listener);
  for (const target of targets) observer.observe(target);
  window.addEventListener('resize', listener);
  return () => {
    observer.disconnect();
    window.removeEventListener('resize', listener);
  };
}

/**
 * Write view: anchors are the ranges painted by `applyWriteHighlights` (or the `<mark>` fallback).
 * `locate` (the editable view) gives the client `y` of a source offset from its block, for text the
 * browser has not laid out (a range has no rectangle there).
 */
export function writeGeometry(
  region: HTMLElement,
  locate?: (start: number) => number | null,
): MarginGeometry {
  let extra = 0;
  let spacer: HTMLDivElement | null = null;
  const root = () => region.querySelector<HTMLElement>('[data-markdown-root]');
  return {
    scrollEl: region,
    contentHeight: () => region.scrollHeight - extra,
    scrollTop: () => region.scrollTop,
    scrollBy: (dy) => {
      region.scrollTop += dy;
    },
    viewportHeight: () => region.clientHeight,
    measure: (anchors) => {
      const out = new Map<string, AnchorMeasure>();
      const markdown = root();
      if (!markdown) return out;
      const base = region.getBoundingClientRect().top - region.scrollTop;
      let tagged: { top: number; s: number }[] | null = null;
      for (const { id, start } of anchors) {
        let top: number | null = null;
        const { ranges, elements } = appliedFor(markdown, id);
        for (const range of ranges) {
          const rect = range.getClientRects()[0];
          if (rect) top = top === null ? rect.top : Math.min(top, rect.top);
        }
        for (const el of elements) {
          const rect = el.getBoundingClientRect();
          top = top === null ? rect.top : Math.min(top, rect.top);
        }
        if (top === null) {
          // The `<mark>` fallback (no Custom Highlight API).
          for (const mark of markdown.querySelectorAll('[data-anchor-ids]')) {
            if (mark.getAttribute('data-anchor-ids')?.split(' ').includes(id)) {
              top = mark.getBoundingClientRect().top;
              break;
            }
          }
        }
        if (top === null && locate) top = locate(start);
        if (top !== null) {
          out.set(id, { y: top - base, approximate: false });
          continue;
        }
        // Resolved, but nothing of it is rendered here: sit by the nearest positioned block.
        tagged ??= [...markdown.querySelectorAll<HTMLElement>('[data-src-start]')].map((el) => ({
          top: el.getBoundingClientRect().top,
          s: Number(el.getAttribute('data-src-start')),
        }));
        let best: { top: number; s: number } | null = null;
        for (const piece of tagged) {
          if (piece.s <= start && (best === null || piece.s >= best.s)) best = piece;
        }
        const fallback = best ?? tagged[0];
        if (fallback) out.set(id, { y: fallback.top - base, approximate: true });
      }
      return out;
    },
    reveal: (id, start) => {
      const markdown = root();
      if (!markdown) return;
      const { ranges, elements } = appliedFor(markdown, id);
      const rect = ranges[0]?.getClientRects()[0] ?? elements[0]?.getBoundingClientRect();
      const mark = markdown.querySelector(`[data-anchor-ids~="${CSS.escape(id)}"]`);
      const box = rect ?? mark?.getBoundingClientRect();
      const view = region.getBoundingClientRect();
      if (!box) {
        // Text in a block the browser has not laid out: scroll to where its block is.
        const y = locate?.(start);
        if (y != null && (y < view.top + 8 || y > view.bottom - 8)) {
          region.scrollTop += y - view.top - view.height / 3;
        }
        return;
      }
      if (box.top < view.top + 8) region.scrollTop -= view.top + 48 - box.top;
      else if (box.bottom > view.bottom - 8) region.scrollTop += box.bottom - view.bottom + 48;
    },
    setExtraBottom: (px) => {
      if (px === extra) return;
      extra = px;
      // A spacer *inside* the scroll content (padding on the scroll container itself is not part of
      // its scrollable overflow in every layout, which left the last card's buttons out of reach).
      if (px > 0) {
        spacer ??= Object.assign(document.createElement('div'), { ariaHidden: 'true' });
        spacer.style.height = `${px}px`;
        spacer.style.flexShrink = '0';
        region.append(spacer);
      } else {
        spacer?.remove();
      }
    },
    subscribe: (listener) => {
      const stop = observe(
        region.firstElementChild ? [region, region.firstElementChild] : [region],
        listener,
      );
      const stopHighlights = onHighlightsApplied(listener);
      return () => {
        stop();
        stopHighlights();
      };
    },
  };
}

function coordsTop(view: EditorView, pos: number): number | null {
  try {
    return view.coordsAtPos(pos, 1)?.top ?? null;
  } catch {
    return null;
  }
}

/** Source view: anchors are CodeMirror positions. */
export function sourceGeometry(view: EditorView): MarginGeometry {
  const scrollEl = view.scrollDOM;
  let extra = 0;
  return {
    scrollEl,
    contentHeight: () => scrollEl.scrollHeight - extra,
    scrollTop: () => scrollEl.scrollTop,
    scrollBy: (dy) => {
      scrollEl.scrollTop += dy;
    },
    viewportHeight: () => scrollEl.clientHeight,
    measure: (anchors) => {
      const out = new Map<string, AnchorMeasure>();
      const base = scrollEl.getBoundingClientRect().top - scrollEl.scrollTop;
      const length = view.state.doc.length;
      for (const { id, start } of anchors) {
        const pos = Math.max(0, Math.min(start, length));
        const top = coordsTop(view, pos);
        if (top !== null) {
          out.set(id, { y: top - base, approximate: false });
        } else {
          // Not rendered (outside CodeMirror's viewport): fall back to its height map.
          out.set(id, {
            y: view.documentTop + view.lineBlockAt(pos).top - base,
            approximate: false,
          });
        }
      }
      return out;
    },
    reveal: (_id, start) => {
      const pos = Math.max(0, Math.min(start, view.state.doc.length));
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'nearest', yMargin: 48 }) });
    },
    setExtraBottom: (px) => {
      if (px === extra) return;
      extra = px;
      // `.cm-content` carries its own 4px block padding; the extra space goes below it.
      view.contentDOM.style.paddingBottom = px > 0 ? `${4 + px}px` : '';
    },
    subscribe: (listener) => observe([scrollEl, view.contentDOM], listener),
  };
}
