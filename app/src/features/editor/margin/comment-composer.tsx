import { useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export const MAX_COMMENT_LENGTH = 20000;

interface CommentComposerProps {
  /** Accessible name of the text box (also its visible placeholder context). */
  label: string;
  placeholder?: string;
  submitLabel?: string;
  initialValue?: string;
  autoFocus?: boolean;
  /** Disables the buttons while the request is in flight. */
  busy?: boolean;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

/**
 * Markdown text box with Submit/Cancel. `Ctrl`/`Cmd`+`Enter` submits, `Escape` cancels (and stops
 * there, so it does not also close an enclosing overlay). `@copilot` is plain text for now.
 */
export function CommentComposer({
  label,
  placeholder = 'Write a comment… Markdown is supported.',
  submitLabel = 'Comment',
  initialValue = '',
  autoFocus = true,
  busy = false,
  onSubmit,
  onCancel,
}: CommentComposerProps) {
  const [value, setValue] = useState(initialValue);
  const hintId = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const blank = value.trim().length === 0;

  function submit() {
    if (!blank && !busy) onSubmit(value.trim());
  }

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        ref={ref}
        // The composer opens on a deliberate user action (Comment / Reply / Edit), so moving focus to it is the point.
        autoFocus={autoFocus}
        aria-label={label}
        aria-describedby={hintId}
        placeholder={placeholder}
        maxLength={MAX_COMMENT_LENGTH}
        value={value}
        disabled={busy}
        className="min-h-16 bg-background text-sm"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <span id={hintId} className="text-[11px] text-muted-foreground">
          Ctrl+Enter to send · Esc to cancel
        </span>
        <div className="flex gap-1.5">
          <Button type="button" variant="ghost" size="xs" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" size="xs" onClick={submit} disabled={blank || busy}>
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
