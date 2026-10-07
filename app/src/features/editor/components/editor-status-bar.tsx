import { ChevronUp } from 'lucide-react';

import { PaneStatusBar } from '@/components/layout/pane-status-bar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useEditorSelectionStore } from '@/stores/editor-selection-store';

interface EditorStatusBarProps {
  /** Characters (code points) and whitespace-delimited words of the live draft. */
  characters: number;
  words: number;
  /** `null` while the source list is still loading — shows no count rather than a wrong "0". */
  sourceCount: number | null;
  /** The source list failed to load; shown instead of a count. */
  sourcesError?: boolean;
  sourcesOpen: boolean;
  /** `id` of the sources drawer this bar's button controls. */
  sourcesDrawerId: string;
  onToggleSources: () => void;
  /** Lets the sheet return focus here when the drawer closes. */
  sourcesButtonRef?: React.Ref<HTMLButtonElement>;
  /** Shows the caret readout (Source view only; Write has no caret in the Markdown source). */
  showCaret: boolean;
  /** Closes the sources drawer — fired by Escape on the sources button while it is open. */
  onCloseSources: () => void;
  className?: string;
}

/**
 * The editor's status strip (issue #182): live counts on the left, the sources drawer toggle in
 * the middle and the Source view's caret position on the right. Save status lives in the header.
 */
export function EditorStatusBar({
  characters,
  words,
  sourceCount,
  sourcesError = false,
  sourcesOpen,
  sourcesDrawerId,
  onToggleSources,
  sourcesButtonRef,
  showCaret,
  onCloseSources,
  className,
}: EditorStatusBarProps) {
  let sourcesLabel = 'Loading sources…';
  if (sourcesError) sourcesLabel = 'Sources unavailable';
  else if (sourceCount !== null)
    sourcesLabel = `${sourceCount} ${sourceCount === 1 ? 'source' : 'sources'}`;
  const fullCounts = `${characters.toLocaleString()} characters · ${words.toLocaleString()} words`;

  return (
    <PaneStatusBar className={cn('@container justify-between font-mono', className)}>
      <span className="shrink-0" title={`${fullCounts}`}>
        <span aria-hidden="true" className="@md:hidden">
          {characters.toLocaleString()} ch · {words.toLocaleString()} w
        </span>
        <span className="sr-only @md:not-sr-only">{fullCounts}</span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="h-5 shrink-0 font-mono"
        ref={sourcesButtonRef}
        aria-expanded={sourcesOpen}
        aria-controls={sourcesDrawerId}
        onClick={onToggleSources}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && sourcesOpen) onCloseSources();
        }}
      >
        {sourcesLabel}
        <ChevronUp className={cn('transition-transform', sourcesOpen && 'rotate-180')} />
      </Button>
      <span className="min-w-0 flex-1 truncate text-right">
        {showCaret ? <CaretReadout /> : null}
      </span>
    </PaneStatusBar>
  );
}

/** Subscribes to the selection store on its own so a caret move re-renders only this readout. */
function CaretReadout() {
  const selection = useEditorSelectionStore((state) => state.selection);
  return selection ? `Ln ${selection.line}, Col ${selection.column}` : null;
}
