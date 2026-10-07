import { EditorView } from '@codemirror/view';

/** What the margin needs to know about the text pane, whichever view is showing. */
export interface MarginGeometry {
  /** The element that scrolls the text; the margin mirrors its scroll position. */
  scrollEl: HTMLElement;
  /**
   * y of the first line of each anchor, in the scroller's content coordinates (0 = top of the
   * scrollable content). Anchors that cannot be located are left out. Reads only; no writes.
   */
  measure: (anchors: readonly { id: string; start: number }[]) => Map<string, number>;
  /** Scrolls the anchor into view in the text pane. */
  reveal: (id: string, start: number) => void;
  /** Calls `listener` when text may have moved without scrolling (resize, reflow, late measuring). */
  subscribe: (listener: () => void) => () => void;
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

/** Write view: anchors are the `<mark data-anchor-ids>` elements `rehypeAnchorSource` produced. */
export function writeGeometry(region: HTMLElement): MarginGeometry {
  const firstMark = (id: string): Element | null => {
    for (const mark of region.querySelectorAll('[data-anchor-ids]')) {
      if (mark.getAttribute('data-anchor-ids')?.split(' ').includes(id)) return mark;
    }
    return null;
  };
  return {
    scrollEl: region,
    measure: (anchors) => {
      const wanted = new Set(anchors.map((anchor) => anchor.id));
      const found = new Map<string, number>();
      const base = region.getBoundingClientRect().top - region.scrollTop;
      for (const mark of region.querySelectorAll('[data-anchor-ids]')) {
        const ids = mark.getAttribute('data-anchor-ids')?.split(' ') ?? [];
        const needed = ids.filter((id) => wanted.has(id) && !found.has(id));
        if (needed.length === 0) continue;
        const top = mark.getBoundingClientRect().top - base;
        for (const id of needed) found.set(id, top);
      }
      return found;
    },
    reveal: (id) => firstMark(id)?.scrollIntoView({ block: 'nearest' }),
    subscribe: (listener) =>
      observe(region.firstElementChild ? [region, region.firstElementChild] : [region], listener),
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
  return {
    scrollEl,
    measure: (anchors) => {
      const out = new Map<string, number>();
      const base = scrollEl.getBoundingClientRect().top - scrollEl.scrollTop;
      const length = view.state.doc.length;
      for (const { id, start } of anchors) {
        const pos = Math.max(0, Math.min(start, length));
        const top = coordsTop(view, pos);
        if (top !== null) {
          out.set(id, top - base);
        } else {
          // Not rendered (outside CodeMirror's viewport): fall back to its height map.
          out.set(id, view.documentTop + view.lineBlockAt(pos).top - base);
        }
      }
      return out;
    },
    reveal: (_id, start) => {
      const pos = Math.max(0, Math.min(start, view.state.doc.length));
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'nearest', yMargin: 48 }) });
    },
    subscribe: (listener) => observe([scrollEl, view.contentDOM], listener),
  };
}
