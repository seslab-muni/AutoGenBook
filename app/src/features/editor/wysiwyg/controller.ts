import { Selection, TextSelection, type Plugin, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

import type { TextRange } from '@/features/editor/lib/anchors';
import { selectionInfo } from '@/features/editor/lib/selection-info';
import type { RagCitation } from '@/features/editor/lib/rag-citation';
import {
  highlightIdsAtPoint,
  paintHighlights,
  supportsCustomHighlights,
} from '@/features/editor/lib/write-highlights';
import type { EditorSelection } from '@/stores/editor-selection-store';

import {
  cleanPastedHtml,
  markdownSlice,
  parseClipboardText,
  pasteBlocks,
  sliceToMarkdown,
} from './clipboard';
import { EditorCore, reconcile } from './core';
import {
  anchorIdsAt,
  highlightDecorations,
  locateHighlights,
  mapTracked,
  trackedFrom,
  trackedMatches,
  trackedPositions,
  type HighlightInput,
  type TrackedHighlight,
} from './editor-highlights';
import { AtomHost, nodeViews } from './node-views';
import { buildPlugins } from './plugins';

export interface ControllerProps {
  /** The draft (LF text). The editor adopts it when it differs from what the editor itself last produced. */
  value: string;
  onChange: (value: string) => void;
  onFlush: () => void;
  readOnly: boolean;
  citations: readonly RagCitation[];
  onCitationClick?: ((key: string) => void) | undefined;
  /** Located anchors (UTF-16 offsets over the draft). */
  highlights: readonly HighlightInput[];
  focusedId: string | null;
  onHighlightClick: (ids: string[]) => void;
  /** After every edit: where the tracked ranges went (`null`: swallowed by the edit). */
  onHighlightsMapped: (ranges: Map<string, TextRange | null>) => void;
  onSelectionChange: (selection: EditorSelection | null) => void;
  /** Open the Source view on this range of the draft (an atom's source). */
  onEditInSource: (range: { from: number; to: number }) => void;
  /** An edit was refused because it cannot be written as Markdown that reads back as itself. */
  onRefused: () => void;
  requestLink: (current: string | null) => Promise<string | null> | string | null;
  placeholder: string;
  ariaLabel: string;
  /** Where the selection starts out (UTF-16 offsets over the draft), e.g. carried over from the Source view. Asked once. */
  initialSelection?: (() => { from: number; to: number } | null) | undefined;
}

/**
 * The editable Write view without React: a ProseMirror view over an `EditorCore` (the editor
 * document plus the source model), the anchors tracked through its edits, and the painting of
 * highlights. The React component only creates it, forwards props and renders atoms.
 *
 * Contract with the owner of the draft: `onChange` is called with the new source after every edit
 * that changed it; a `value` that is not one the editor produced (or is producing) replaces the
 * whole content without entering the undo history.
 */
/**
 * React saves the focused element's selection before every commit, and for an element whose
 * `contentEditable` reads `"true"` it does so by walking the element's whole DOM tree (it counts
 * text offsets). The editor's DOM is the whole section - tens of thousands of nodes with KaTeX - and
 * the sheet commits on every keystroke, so that walk cost several milliseconds per key. ProseMirror
 * owns this element and its selection, so React's save/restore is of no use here: the element
 * answers `"inherit"` (the real attribute stays `"true"`, nothing else reads the property), which is
 * not one of the values React's check looks for.
 */
function keepReactOutOfTheEditor(dom: HTMLElement) {
  Object.defineProperty(dom, 'contentEditable', {
    configurable: true,
    get(this: HTMLElement) {
      const attr = this.getAttribute('contenteditable');
      return attr === 'true' ? 'inherit' : (attr ?? 'inherit');
    },
    set(this: HTMLElement, value: string) {
      this.setAttribute('contenteditable', value);
    },
  });
}

/** What the editor's element carries outside production builds, for tests and browser checks. */
export type EditorDebugElement = HTMLElement & { __md?: { view: EditorView; core: EditorCore } };

export class EditorController {
  readonly host: AtomHost;
  readonly core: EditorCore;
  readonly view: EditorView;
  private props: ControllerProps;
  private tracked: TrackedHighlight[];
  /** Texts handed to `onChange` that the owner may not have passed back as `value` yet. */
  private pending: string[] = [];
  private paintFrame: number | null = null;
  private selectionFrame: number | null = null;
  private unpaint: (() => void) | null = null;
  private decoVersion = 0;
  private deferred: string | null = null;
  private repaintAfterCompose = false;
  private destroyed = false;
  private readonly custom = supportsCustomHighlights();

  constructor(container: HTMLElement, props: ControllerProps, host: AtomHost) {
    this.props = props;
    this.host = host;
    this.tracked = trackedFrom(props.highlights, props.value.length);
    const plugins: Plugin[] = [
      ...buildPlugins(
        {
          onFlush: () => this.props.onFlush(),
          onEditInSource: (pos) => this.editInSource(pos),
          requestLink: (current) => this.props.requestLink(current),
        },
        props.placeholder,
      ),
      highlightDecorations(() => ({
        tracked: this.tracked,
        focusedId: this.props.focusedId,
        model: this.core.model,
        enabled: !this.custom,
        version: this.decoVersion,
      })),
    ];
    this.core = new EditorCore(props.value, plugins);
    host.onEditInSource = (pos) => this.editInSource(pos);
    host.onCitationClick = props.onCitationClick;
    host.setCitations(new Map(props.citations.map((citation) => [citation.id, citation])));

    this.view = new EditorView(container, {
      state: this.core.state,
      dispatchTransaction: (tr) => this.dispatch(tr),
      editable: () => !this.props.readOnly,
      attributes: () => ({
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': this.props.ariaLabel,
        ...(this.props.readOnly ? { 'aria-readonly': 'true' } : {}),
        class: 'md-editor text-sm text-foreground',
        'data-markdown-root': '',
        spellcheck: 'true',
      }),
      nodeViews: nodeViews(host),
      clipboardTextParser: (text, $context, plain) => parseClipboardText(text, $context, plain),
      clipboardTextSerializer: (slice) => sliceToMarkdown(slice),
      transformPastedHTML: cleanPastedHtml,
      handlePaste: (view, event) => {
        // Plain text (no HTML): ProseMirror opens the slice as far as it can, which folds a pasted
        // heading into the paragraph at the caret; blocks that began on a new line stay blocks.
        const data = event.clipboardData;
        const text = data?.getData('text/plain');
        if (!text || data?.getData('text/html')) return false;
        if (view.state.selection.$from.parent.type.spec.code) return false;
        return pasteBlocks(view, markdownSlice(text));
      },
      handleDOMEvents: {
        blur: () => {
          // Text typed as `$x$` or `[@key]` becomes the formula or the citation once the writer is elsewhere.
          const state = reconcile(this.core);
          if (state) {
            this.view.updateState(state);
            this.schedulePaint();
          }
          this.props.onFlush();
          return false;
        },
        click: (_view, event) => {
          this.handleClick(event);
          return false;
        },
        compositionend: () => {
          // What waited for the composition to end.
          setTimeout(() => this.afterComposition(), 0);
          return false;
        },
      },
    });

    keepReactOutOfTheEditor(this.view.dom);
    // Browser checks and route tests drive the editor through this (stripped from production builds).
    if (!import.meta.env.PROD)
      (this.view.dom as EditorDebugElement).__md = { view: this.view, core: this.core };
    const initial = props.initialSelection?.() ?? null;
    if (initial) this.placeSelection(initial.from, initial.to, true);
    this.schedulePaint();
    this.publishSelection();
  }

  // ---- props -----------------------------------------------------------------------------

  setProps(next: ControllerProps) {
    const previous = this.props;
    this.props = next;
    this.host.onCitationClick = next.onCitationClick;
    if (next.citations !== previous.citations) {
      this.host.setCitations(new Map(next.citations.map((citation) => [citation.id, citation])));
    }
    if (next.readOnly !== previous.readOnly)
      this.view.setProps({ editable: () => !this.props.readOnly });

    if (next.value !== this.core.text) {
      if (this.pending.includes(next.value)) {
        // A text this editor produced, handed back late: the editor already has newer text.
      } else {
        this.replaceContent(next.value);
      }
    } else {
      this.pending = [];
    }

    const highlightsChanged = next.highlights !== previous.highlights;
    // A new set of ranges (comments loaded, a card filtered out) or another focused card is drawn at
    // once, not a frame later: the card the user just focused should not wait for its highlight.
    if (highlightsChanged && !trackedMatches(this.tracked, next.highlights)) {
      this.tracked = trackedFrom(next.highlights, this.core.text.length);
      this.paintNow();
    } else if (next.focusedId !== previous.focusedId) {
      this.paintNow();
    }
  }

  focus() {
    this.view.focus();
  }

  destroy() {
    this.destroyed = true;
    if (this.paintFrame !== null) cancelAnimationFrame(this.paintFrame);
    if (this.selectionFrame !== null) cancelAnimationFrame(this.selectionFrame);
    this.unpaint?.();
    this.unpaint = null;
    this.view.destroy();
  }

  // ---- edits -------------------------------------------------------------------------------

  private dispatch(tr: Transaction) {
    if (this.destroyed) return;
    const before = this.core.text;
    const applied = this.core.apply(tr);
    if (!applied.ok) {
      this.props.onRefused();
      this.redraw();
      return;
    }
    this.view.updateState(applied.state);
    if (applied.docChanged) {
      if (applied.change && this.tracked.length > 0)
        this.tracked = mapTracked(this.tracked, applied.change);
      if (applied.text !== before) {
        this.pending.push(applied.text);
        if (this.pending.length > 8) this.pending.shift();
        this.props.onChange(applied.text);
      }
      if (this.tracked.length > 0) this.props.onHighlightsMapped(trackedPositions(this.tracked));
      this.schedulePaint();
    }
    if (tr.selectionSet || applied.docChanged) this.scheduleSelection();
  }

  /** Brings the DOM back in line with the state after a refused edit the browser had already shown. */
  private redraw() {
    // A new `nodeViews` object makes ProseMirror draw the whole document again from the state.
    this.view.setProps({ nodeViews: nodeViews(this.host) });
  }

  /** The server's (or the other view's) text replaces everything; nothing of it enters the undo history. */
  private replaceContent(value: string) {
    if (this.view.composing) {
      this.deferred = value;
      return;
    }
    const selection = this.core.state.selection;
    const from = this.core.model.posToSrc(selection.from, 'start');
    const to = this.core.model.posToSrc(selection.to, 'end');
    this.pending = [];
    const state = this.core.reset(value);
    this.view.updateState(state);
    this.tracked = trackedFrom(this.props.highlights, value.length);
    this.placeSelection(from, to);
    this.schedulePaint();
    this.scheduleSelection();
  }

  private afterComposition() {
    if (this.destroyed) return;
    if (this.deferred !== null && this.deferred !== this.core.text) {
      const value = this.deferred;
      this.deferred = null;
      this.replaceContent(value);
    }
    this.deferred = null;
    if (this.repaintAfterCompose) {
      this.repaintAfterCompose = false;
      this.schedulePaint();
    }
  }

  private placeSelection(fromSrc: number, toSrc: number, reveal = false) {
    const { model } = this.core;
    const doc = this.core.state.doc;
    const clamp = (pos: number) => Math.max(0, Math.min(pos, doc.content.size));
    const a = clamp(model.srcToPos(fromSrc, 'start'));
    const b = clamp(model.srcToPos(toSrc, 'end'));
    let selection: Selection;
    try {
      selection = TextSelection.between(doc.resolve(Math.min(a, b)), doc.resolve(Math.max(a, b)));
    } catch {
      selection = Selection.atStart(doc);
    }
    const tr = this.core.state.tr.setSelection(selection);
    const applied = this.core.apply(reveal ? tr.scrollIntoView() : tr);
    if (applied.ok) this.view.updateState(applied.state);
  }

  private editInSource(pos: number) {
    const node = this.core.state.doc.nodeAt(pos);
    if (!node) return;
    const { model } = this.core;
    this.props.onEditInSource({
      from: model.posToSrc(pos, 'start'),
      to: model.posToSrc(pos + node.nodeSize, 'end'),
    });
  }

  // ---- highlights and selection -------------------------------------------------------------

  private handleClick(event: MouseEvent) {
    let ids: string[];
    if (this.custom) {
      const selection = document.getSelection();
      ids =
        !selection || selection.isCollapsed
          ? highlightIdsAtPoint(this.view.dom, event.clientX, event.clientY, event.target)
          : [];
    } else {
      ids = anchorIdsAt(event.target);
    }
    if (ids.length > 0) this.props.onHighlightClick(ids);
  }

  schedulePaint() {
    if (this.paintFrame !== null || this.destroyed) return;
    this.paintFrame = requestAnimationFrame(() => {
      this.paintFrame = null;
      this.paint();
    });
  }

  private paintNow() {
    if (this.paintFrame !== null) {
      cancelAnimationFrame(this.paintFrame);
      this.paintFrame = null;
    }
    this.paint();
  }

  private paint() {
    if (this.destroyed) return;
    // Never touch the DOM (decorations) or the registry while text is being composed.
    if (this.view.composing) {
      this.repaintAfterCompose = true;
      return;
    }
    if (this.custom) {
      this.unpaint?.();
      const located = locateHighlights(this.view, this.core.model, this.tracked);
      this.unpaint = paintHighlights(this.view.dom, located, this.props.focusedId);
    } else {
      this.decoVersion += 1;
      this.view.updateState(this.view.state);
    }
  }

  private scheduleSelection() {
    if (this.selectionFrame !== null || this.destroyed) return;
    this.selectionFrame = requestAnimationFrame(() => {
      this.selectionFrame = null;
      this.publishSelection();
    });
  }

  private publishSelection() {
    if (this.destroyed) return;
    const { model, state } = this.core;
    const { selection } = state;
    const from = model.posToSrc(selection.from, 'start');
    const to = selection.empty ? from : model.posToSrc(selection.to, 'end');
    const head = selection.empty
      ? from
      : model.posToSrc(selection.head, selection.head === selection.from ? 'start' : 'end');
    this.props.onSelectionChange(selectionInfo(model.text, from, Math.max(from, to), head));
  }

  /**
   * Client `y` of source offset `start`, from the block that holds it: for text in a block the
   * browser has not laid out (`content-visibility`), where a text range has no rectangle.
   */
  locateTop(start: number): number | null {
    const block = this.core.model.blockAt(start);
    if (!block) return null;
    const el = this.view.nodeDOM(block.pos);
    if (!(el instanceof HTMLElement)) return null;
    const rect = el.getBoundingClientRect();
    if (rect.height === 0 && rect.top === 0) return null;
    const fraction =
      block.end > block.start ? (start - block.start) / (block.end - block.start) : 0;
    return rect.top + Math.max(0, Math.min(1, fraction)) * rect.height;
  }

  /** Test and caller access to the current source offsets of the selection. */
  sourceSelection(): { from: number; to: number } {
    const { model, state } = this.core;
    const { selection } = state;
    const from = model.posToSrc(selection.from, 'start');
    return { from, to: selection.empty ? from : model.posToSrc(selection.to, 'end') };
  }
}
