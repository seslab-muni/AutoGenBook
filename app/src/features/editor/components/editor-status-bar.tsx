import { PaneStatusBar } from '@/components/layout/pane-status-bar';
import { Badge } from '@/components/ui/badge';
import { SaveStatusBadge } from '@/features/editor/components/save-status-badge';
import type { SaveStatus } from '@/features/editor/lib/save-status';
import { cn } from '@/lib/utils';

/** Words per page assumed for the `≈ pages` estimate — the same 320 wpp the AI Studio mock used. */
const WORDS_PER_PAGE = 320;

interface EditorStatusBarProps {
  /** Server-derived word count — shown as-is (never an optimistic local count) once saved. */
  serverWords: number;
  /** Live word count of the unsaved draft, shown instead of `serverWords` while dirty. */
  draftWords: number;
  isDirty: boolean;
  equationCount: number;
  status: SaveStatus;
  reviewerScore?: number | null;
  className?: string;
}

export function EditorStatusBar({
  serverWords,
  draftWords,
  isDirty,
  equationCount,
  status,
  reviewerScore,
  className,
}: EditorStatusBarProps) {
  const words = isDirty ? draftWords : serverWords;
  const pages = Math.max(1, Math.round(words / WORDS_PER_PAGE));

  return (
    <PaneStatusBar className={cn('justify-between font-mono', className)}>
      <div className="flex items-center gap-3">
        <span>{words} words</span>
        <span className="text-muted-foreground/50">·</span>
        <span title={`Estimated at ${WORDS_PER_PAGE} words/page`}>≈ {pages} pages</span>
        <span className="text-muted-foreground/50">·</span>
        <span>
          {equationCount} equation{equationCount === 1 ? '' : 's'}
        </span>
        {reviewerScore != null ? (
          <>
            <span className="text-muted-foreground/50">·</span>
            <Badge variant="secondary" className="font-mono">
              Review {reviewerScore.toFixed(1)}
            </Badge>
          </>
        ) : null}
      </div>
      <SaveStatusBadge status={status} />
    </PaneStatusBar>
  );
}
