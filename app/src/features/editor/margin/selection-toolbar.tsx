import { useLayoutEffect, useRef, useState } from 'react';
import { MessageSquarePlus, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';

/** Shown on the buttons and wired in `ManuscriptSheet`. */
export const COMMENT_SHORTCUT = 'Ctrl+Alt+M';
export const PROMPT_SHORTCUT = 'Ctrl+Alt+P';

const QUICK_CHIPS = ['Add proof', 'More rigorous', 'Shorter', 'Cite'] as const;

interface SelectionToolbarProps {
  /** Selection rectangle relative to the toolbar's positioned parent. */
  rect: { top: number; bottom: number; left: number; right: number };
  /** Size of the positioned parent, to keep the bar inside the pane. */
  containerWidth: number;
  containerHeight?: number;
  onComment: () => void;
  /**
   * `Prompt…` and the quick chips: each renders only with its handler supplied (none for a section the
   * copilot cannot revise); with neither, only `Comment` renders.
   */
  onPrompt?: (() => void) | undefined;
  onChip?: ((chip: string) => void) | undefined;
}

/**
 * The floating bar over a non-empty text selection (either view). It must never take focus or
 * the selection away from the text: pointer presses are cancelled before they move focus, and the
 * same actions are reachable from the keyboard (`Ctrl+Alt+M` comments on the selection; `Escape`
 * dismisses it), so the buttons are an extra, not the only path.
 */
export function SelectionToolbar({
  rect,
  containerWidth,
  containerHeight = Number.POSITIVE_INFINITY,
  onComment,
  onPrompt,
  onChip,
}: SelectionToolbarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (ref.current) setWidth(ref.current.offsetWidth);
  }, [onPrompt, onChip]);

  const height = 36;
  const above = rect.top - height - 8;
  const wanted = above >= 4 ? above : rect.bottom + 8;
  const top = Math.max(4, Math.min(wanted, containerHeight - height - 4));
  const left = Math.max(8, Math.min(rect.left, containerWidth - width - 8));

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Selection actions"
      className="absolute z-10 flex items-center gap-0.5 rounded-lg border border-foreground/20 bg-foreground p-1 text-background shadow-lg"
      style={{ top, left }}
      // A press on the bar must not blur the editor or collapse the selection.
      onMouseDown={(event) => event.preventDefault()}
    >
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="text-background hover:bg-background/15 hover:text-background"
        aria-keyshortcuts="Control+Alt+M"
        title={`Comment (${COMMENT_SHORTCUT}). With the caret inside a highlight, ${COMMENT_SHORTCUT} jumps to its card instead.`}
        onClick={onComment}
      >
        <MessageSquarePlus />
        Comment
      </Button>
      {onPrompt ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-background hover:bg-background/15 hover:text-background"
          aria-keyshortcuts="Control+Alt+P"
          title={`Prompt the copilot about the selection (${PROMPT_SHORTCUT})`}
          onClick={onPrompt}
        >
          <Sparkles />
          Prompt…
        </Button>
      ) : null}
      {onChip ? (
        <>
          {QUICK_CHIPS.map((chip) => (
            <Button
              key={chip}
              type="button"
              variant="ghost"
              size="xs"
              className="text-background hover:bg-background/15 hover:text-background"
              onClick={() => onChip(chip)}
            >
              {chip}
            </Button>
          ))}
        </>
      ) : null}
    </div>
  );
}
