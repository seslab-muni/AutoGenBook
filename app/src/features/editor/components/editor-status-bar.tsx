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
  sourcesOpen: boolean;
  /** `id` of the sources drawer this bar's button controls. */
  sourcesDrawerId: string;
  onToggleSources: () => void;
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
  sourcesOpen,
  sourcesDrawerId,
  onToggleSources,
  showCaret,
  onCloseSources,
  className,
}: EditorStatusBarProps) {
  return (
    <PaneStatusBar className={cn('justify-between font-mono', className)}>
      <span className="min-w-0 flex-1 truncate">
        {characters.toLocaleString()} characters · {words.toLocaleString()} words
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="h-5 shrink-0 font-mono"
        aria-expanded={sourcesOpen}
        aria-controls={sourcesDrawerId}
        onClick={onToggleSources}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && sourcesOpen) onCloseSources();
        }}
      >
        {sourceCount === null
          ? 'Sources'
          : `${sourceCount} ${sourceCount === 1 ? 'source' : 'sources'}`}
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
