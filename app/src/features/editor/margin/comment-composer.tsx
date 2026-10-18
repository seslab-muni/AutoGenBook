import { useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useMarginStore } from './margin-store';
import { problemMessage } from './errors';
import { mentionsCopilot } from './mentions';

export const MAX_COMMENT_LENGTH = 20000;

interface CommentComposerProps {
  /** Accessible name of the text box (also its visible placeholder context). */
  label: string;
  placeholder?: string;
  submitLabel?: string;
  initialValue?: string;
  /**
   * Where the unsent text is kept in the margin store (`nodeId:scope`), so it survives this
   * composer unmounting. Cleared on a successful send and on cancel.
   */
  draftKey?: string;
  autoFocus?: boolean;
  /**
   * The copilot can be asked from this composer: a text that mentions `@copilot` is a prompt, so the
   * button says what sending will do ("Comment and ask Copilot") before it starts a model job.
   */
  askCopilot?: boolean;
  /**
   * Sends the text. The composer stays open, keeping the text, while this runs and again if it
   * rejects (the server's message is shown); the caller closes it by unmounting it on success.
   */
  onSubmit: (text: string) => Promise<unknown>;
  onCancel: () => void;
}

/**
 * Markdown text box with Submit/Cancel. `Ctrl`/`Cmd`+`Enter` submits, `Escape` cancels (and stops
 * there, so it does not also close an enclosing overlay). `@copilot` is plain text for now. A second
 * submit while one is in flight is ignored, and a failed one never loses what was typed.
 */
export function CommentComposer({
  label,
  placeholder = 'Write a comment… Markdown is supported.',
  submitLabel = 'Comment',
  initialValue = '',
  draftKey,
  autoFocus = true,
  askCopilot = false,
  onSubmit,
  onCancel,
}: CommentComposerProps) {
  const [value, setValue] = useState(initialValue);
  const setDraftText = useMarginStore((state) => state.setDraftText);
  const clearDraftText = useMarginStore((state) => state.clearDraftText);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const hintId = useId();
  const errorId = useId();
  const blank = value.trim().length === 0;
  // Opening on existing text (an edit, a restored draft): the caret goes to the end, not the start.
  useEffect(() => {
    const element = textarea.current;
    if (element && autoFocus) element.setSelectionRange(element.value.length, element.value.length);
  }, [autoFocus]);

  async function submit() {
    if (blank || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value.trim());
      if (draftKey) clearDraftText(draftKey);
    } catch (failure) {
      setError(problemMessage(failure));
      inFlight.current = false;
      setBusy(false);
    }
    // On success the caller unmounts this composer; there is nothing left to reset.
  }

  function cancel() {
    if (draftKey) clearDraftText(draftKey);
    onCancel();
  }

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        // The composer opens on a deliberate user action (Comment / Reply / Edit), so moving focus to it is the point.
        ref={textarea}
        autoFocus={autoFocus}
        aria-label={label}
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
        aria-invalid={error ? true : undefined}
        placeholder={placeholder}
        maxLength={MAX_COMMENT_LENGTH}
        value={value}
        readOnly={busy}
        className="min-h-16 bg-background text-sm"
        onChange={(event) => {
          setValue(event.target.value);
          if (draftKey) setDraftText(draftKey, event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void submit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (!busy) cancel();
          }
        }}
      />
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive-text">
          Not sent: {error}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <span id={hintId} className="text-[11px] text-muted-foreground">
          Ctrl+Enter to send · Esc to cancel
        </span>
        <div className="flex gap-1.5">
          <Button type="button" variant="ghost" size="xs" onClick={cancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" size="xs" onClick={() => void submit()} disabled={blank || busy}>
            {busy
              ? 'Sending…'
              : askCopilot && mentionsCopilot(value)
                ? `${submitLabel} and ask Copilot`
                : submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
