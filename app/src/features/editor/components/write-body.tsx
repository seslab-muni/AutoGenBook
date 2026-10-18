import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { LazyMarkdownView } from '@/features/editor/components/markdown-view-lazy';
import type { HighlightInput } from '@/features/editor/wysiwyg/editor-highlights';
import type {
  MarkdownEditorHandle,
  MarkdownEditorProps,
} from '@/features/editor/wysiwyg/markdown-editor';
import type { AnchorMark } from '@/features/editor/lib/rehype-anchor-source';
import type { RagCitation } from '@/features/editor/lib/rag-citation';

type EditorModule = typeof import('@/features/editor/wysiwyg/markdown-editor');

let editorModule: Promise<EditorModule> | null = null;

/**
 * The editor lives in its own chunk (ProseMirror and the Markdown model, about 80 kB gzipped) that
 * is only fetched once a Write view is first made editable; the read-only view and the Source view
 * never load it. A failed fetch is not retried in place: the browser remembers a failed dynamic
 * import for the page's lifetime (Chromium keeps the failed module in its module map), so asking
 * again does nothing - the notice offers a reload instead (see `WriteBody`).
 */
function loadEditor(): Promise<EditorModule> {
  editorModule ??= import('@/features/editor/wysiwyg/markdown-editor');
  return editorModule;
}

interface WriteBodyProps {
  /** The section can be edited here (Markdown, not generating, a leaf). Otherwise it stays the read-only view. */
  editable: boolean;
  markdown: string;
  citations: readonly RagCitation[];
  anchorMarks: readonly AnchorMark[];
  focusedAnchorId: string | null;
  highlights: readonly HighlightInput[];
  onCitationClick: (citeKey: string) => void;
  onAnchorClick: (ids: string[]) => void;
  editorProps: Omit<
    MarkdownEditorProps,
    | 'value'
    | 'citations'
    | 'highlights'
    | 'focusedAnchorId'
    | 'onCitationClick'
    | 'onHighlightClick'
  >;
  /** The read-only text of an empty section that cannot be edited. */
  emptyNote: React.ReactNode;
}

/**
 * The text of the Write view. The read-only renderer paints first, at once, and is swapped for the
 * editor in the same place when the editor chunk has loaded (same typography, same scroll
 * container, so nothing moves); if the chunk cannot be loaded the section stays read-only with a
 * notice (reload the page, or edit in Source).
 *
 * Until the editor is there the text is a busy, read-only textbox that already takes focus: what is
 * typed meanwhile (characters, Enter, Backspace) is kept and replayed into the editor when it is
 * created, so nothing typed is lost, and a click that put the caret in the text gets the editor's
 * focus and the same caret (`initialSelection`).
 */
export function WriteBody({
  editable,
  markdown,
  citations,
  anchorMarks,
  focusedAnchorId,
  highlights,
  onCitationClick,
  onAnchorClick,
  editorProps,
  emptyNote,
}: WriteBodyProps) {
  const [module, setModule] = useState<EditorModule | null>(null);
  const [failed, setFailed] = useState(false);
  /** Keys typed into the read-only first paint while the editor chunk was loading. */
  const typedMeanwhile = useRef<string[]>([]);
  const [replay, setReplay] = useState<readonly string[]>([]);
  /** How many typed keys could not be applied because the editor never arrived. */
  const [lost, setLost] = useState(0);

  useEffect(() => {
    if (!editable) return undefined;
    let alive = true;
    loadEditor().then(
      (loaded) => {
        if (alive) {
          setReplay(typedMeanwhile.current);
          typedMeanwhile.current = [];
          setModule(loaded);
        }
      },
      () => {
        if (alive) {
          setLost(typedMeanwhile.current.length);
          setFailed(true);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [editable]);

  if (editable && module) {
    const { MarkdownEditor } = module;
    return (
      <MarkdownEditor
        {...editorProps}
        initialInput={replay}
        value={markdown}
        citations={citations}
        highlights={highlights}
        focusedAnchorId={focusedAnchorId}
        onCitationClick={onCitationClick}
        onHighlightClick={onAnchorClick}
      />
    );
  }

  const readOnlyView =
    markdown.trim().length === 0 ? (
      editable ? (
        <p className="my-2.5 text-sm leading-relaxed text-muted-foreground">Start writing…</p>
      ) : (
        emptyNote
      )
    ) : (
      <LazyMarkdownView
        markdown={markdown}
        citations={citations}
        anchorMarks={anchorMarks}
        focusedAnchorId={focusedAnchorId}
        sourceMap
        onCitationClick={onCitationClick}
        onAnchorClick={onAnchorClick}
      />
    );

  const reload = () => {
    // What is unsaved is saved first, then the page asks for the current build.
    editorProps.onFlush();
    window.setTimeout(() => window.location.reload(), 300);
  };

  return (
    <>
      {editable && failed ? (
        <div
          role="status"
          className="mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 font-sans text-xs"
        >
          <span className="min-w-0 flex-1">
            The editor could not be loaded, so this view is read-only. Reload the page to try again,
            or switch to Source to edit.
            {lost > 0 ? ' What you typed meanwhile was not applied.' : ''}
          </span>
          <Button type="button" size="xs" variant="outline" onClick={reload}>
            Reload page
          </Button>
        </div>
      ) : null}
      {editable && !failed ? (
        <div
          role="textbox"
          aria-multiline="true"
          aria-readonly="true"
          aria-busy="true"
          aria-label={editorProps.ariaLabel ?? 'Section text'}
          tabIndex={0}
          className="outline-none"
          data-write-pending=""
          onKeyDown={(event) => {
            if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) {
              return;
            }
            const { key } = event;
            if (key.length === 1 || key === 'Enter' || key === 'Backspace') {
              event.preventDefault();
              typedMeanwhile.current.push(key);
            }
          }}
        >
          {readOnlyView}
        </div>
      ) : (
        readOnlyView
      )}
    </>
  );
}

export type { MarkdownEditorHandle };
