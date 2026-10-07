import { ChevronUp } from 'lucide-react';

import { PaneStatusBar } from '@/components/layout/pane-status-bar';
import { Button } from '@/components/ui/button';
import type { EditorCaret } from '@/features/editor/components/section-editor';
import { cn } from '@/lib/utils';

interface EditorStatusBarProps {
  /** Characters (code points) and whitespace-delimited words of the live draft. */
  characters: number;
  words: number;
  sourceCount: number;
  sourcesOpen: boolean;
  /** `id` of the sources drawer this bar's button controls. */
  sourcesDrawerId: string;
  onToggleSources: () => void;
  /** `null` hides the caret readout (the Write view has no caret in the Markdown source). */
  caret: EditorCaret | null;
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
  caret,
  className,
}: EditorStatusBarProps) {
  return (
    <PaneStatusBar className={cn('justify-between font-mono', className)}>
      <span className="flex-1">
        {characters.toLocaleString()} characters · {words.toLocaleString()} words
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="h-5 font-mono"
        aria-expanded={sourcesOpen}
        aria-controls={sourcesDrawerId}
        onClick={onToggleSources}
      >
        {sourceCount} {sourceCount === 1 ? 'source' : 'sources'}
        <ChevronUp className={cn('transition-transform', sourcesOpen && 'rotate-180')} />
      </Button>
      <span className="flex-1 text-right">
        {caret ? `Ln ${caret.line}, Col ${caret.column}` : null}
      </span>
    </PaneStatusBar>
  );
}
