import { useEffect, useState } from 'react';

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
 * never load it. A failed fetch is forgotten so that Try again can ask once more.
 */
function loadEditor(): Promise<EditorModule> {
  editorModule ??= import('@/features/editor/wysiwyg/markdown-editor').catch((error: unknown) => {
    editorModule = null;
    throw error;
  });
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
 * notice and the Source view remains the way to edit.
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
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!editable) return undefined;
    let alive = true;
    loadEditor().then(
      (loaded) => {
        if (alive) {
          setFailed(false);
          setModule(loaded);
        }
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [editable, attempt]);

  if (editable && module) {
    const { MarkdownEditor } = module;
    return (
      <MarkdownEditor
        {...editorProps}
        value={markdown}
        citations={citations}
        highlights={highlights}
        focusedAnchorId={focusedAnchorId}
        onCitationClick={onCitationClick}
        onHighlightClick={onAnchorClick}
      />
    );
  }

  return (
    <>
      {editable && failed ? (
        <div
          role="status"
          className="mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 font-sans text-xs"
        >
          <span className="min-w-0 flex-1">
            The editor could not be loaded, so this view is read-only. Switch to Source to edit.
          </span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Try again
          </Button>
        </div>
      ) : null}
      {markdown.trim().length === 0 ? (
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
      )}
    </>
  );
}

export type { MarkdownEditorHandle };
