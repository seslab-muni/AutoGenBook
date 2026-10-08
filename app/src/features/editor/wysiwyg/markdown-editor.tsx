import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { EditorView } from 'prosemirror-view';

import { InlineMarkdown, MarkdownView } from '@/features/editor/components/markdown-view';
import type { TextRange } from '@/features/editor/lib/anchors';
import type { RagCitation } from '@/features/editor/lib/rag-citation';
import type { EditorSelection } from '@/stores/editor-selection-store';

import { EditorController, type ControllerProps } from './controller';
import type { HighlightInput } from './editor-highlights';
import { AtomHost } from './node-views';

/** What the sheet gets once the editor exists. */
export interface MarkdownEditorHandle {
  view: EditorView;
  focus: () => void;
  /** Source offsets (UTF-16) of the current selection. */
  sourceSelection: () => { from: number; to: number };
  /** Client `y` of a source offset, from its block (for text the browser has not laid out). */
  locateTop: (start: number) => number | null;
}

export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  onFlush: () => void;
  readOnly?: boolean;
  citations?: readonly RagCitation[];
  onCitationClick?: ((key: string) => void) | undefined;
  highlights?: readonly HighlightInput[];
  focusedAnchorId?: string | null;
  onHighlightClick?: (ids: string[]) => void;
  onHighlightsMapped?: (ranges: Map<string, TextRange | null>, external: boolean) => void;
  onSelectionChange?: (selection: EditorSelection | null) => void;
  onEditInSource?: (range: { from: number; to: number }) => void;
  onRefused?: () => void;
  /** Ask for a link target (Ctrl+K); `null` cancels, an empty string removes the link. */
  requestLink?: (current: string | null) => Promise<string | null> | string | null;
  onReady?: (handle: MarkdownEditorHandle | null) => void;
  placeholder?: string;
  ariaLabel?: string;
  initialSelection?: () => { from: number; to: number } | null;
  className?: string;
}

const NO_CITATIONS: readonly RagCitation[] = [];
const NO_HIGHLIGHTS: readonly HighlightInput[] = [];

function defaultRequestLink(current: string | null): string | null {
  if (typeof window === 'undefined') return null;
  return window.prompt('Link address (leave empty to remove the link)', current ?? 'https://');
}

/** Renders the block atoms (callouts, tables, display math...) with the read-only view's renderer. */
function AtomPortals({
  host,
  citations,
  onCitationClick,
}: {
  host: AtomHost;
  citations: readonly RagCitation[];
  onCitationClick: ((key: string) => void) | undefined;
}) {
  useSyncExternalStore(host.subscribe, host.getSnapshot);
  return (
    <>
      {host
        .blockEntries()
        .map(([target, record]) =>
          createPortal(
            record.kind === 'inline-math' ? (
              <InlineMarkdown markdown={record.source} />
            ) : (
              <MarkdownView
                markdown={record.source}
                citations={citations}
                {...(onCitationClick ? { onCitationClick } : {})}
              />
            ),
            target,
            String(record.id),
          ),
        )}
    </>
  );
}

/**
 * The Write view when the section is editable (issue #182, phase 5): a ProseMirror editor over the
 * section's Markdown, written back to `onChange` as Markdown with untouched blocks byte-identical
 * (see `source-model.ts`). All behaviour lives in `EditorController`; this component creates it,
 * forwards props and renders the atoms' read-only output.
 */
export function MarkdownEditor(props: MarkdownEditorProps) {
  const [host] = useState(() => new AtomHost());
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<EditorController | null>(null);
  const readyRef = useRef(props.onReady);

  const controllerProps = (p: MarkdownEditorProps): ControllerProps => ({
    value: p.value,
    onChange: p.onChange,
    onFlush: p.onFlush,
    readOnly: p.readOnly ?? false,
    citations: p.citations ?? NO_CITATIONS,
    onCitationClick: p.onCitationClick,
    highlights: p.highlights ?? NO_HIGHLIGHTS,
    focusedId: p.focusedAnchorId ?? null,
    onHighlightClick: (ids) => p.onHighlightClick?.(ids),
    onHighlightsMapped: (ranges) => p.onHighlightsMapped?.(ranges, false),
    onSelectionChange: (selection) => p.onSelectionChange?.(selection),
    onEditInSource: (range) => p.onEditInSource?.(range),
    onRefused: () => p.onRefused?.(),
    requestLink: p.requestLink ?? defaultRequestLink,
    placeholder: p.placeholder ?? 'Start writing…',
    ariaLabel: p.ariaLabel ?? 'Section text',
    initialSelection: p.initialSelection,
  });

  useLayoutEffect(() => {
    readyRef.current = props.onReady;
  });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const controller = new EditorController(container, controllerProps(props), host);
    controllerRef.current = controller;
    readyRef.current?.({
      view: controller.view,
      focus: () => controller.focus(),
      sourceSelection: () => controller.sourceSelection(),
      locateTop: (start) => controller.locateTop(start),
    });
    return () => {
      readyRef.current?.(null);
      controller.destroy();
      controllerRef.current = null;
    };
    // Created once; props are forwarded by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  useLayoutEffect(() => {
    controllerRef.current?.setProps(controllerProps(props));
  });

  return (
    <>
      <div ref={containerRef} className={props.className} />
      <AtomPortals
        host={host}
        citations={props.citations ?? NO_CITATIONS}
        onCitationClick={props.onCitationClick}
      />
    </>
  );
}

export default MarkdownEditor;
