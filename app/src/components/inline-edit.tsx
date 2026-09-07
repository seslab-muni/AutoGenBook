import { useRef, useState, type KeyboardEvent } from 'react';

import { cn } from '@/lib/utils';

interface InlineEditProps {
  value: string;
  onCommit: (value: string) => void;
  className?: string;
  inputClassName?: string;
  'aria-label'?: string;
}

/** Double-click to edit text in place; Enter or blur commits, Escape reverts. */
export function InlineEdit({
  value,
  onCommit,
  className,
  inputClassName,
  'aria-label': ariaLabel,
}: InlineEditProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const revertedRef = useRef(false);

  function startEditing() {
    setDraft(value);
    revertedRef.current = false;
    setIsEditing(true);
  }

  function commit() {
    setIsEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) {
      onCommit(trimmed);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      revertedRef.current = true;
      setIsEditing(false);
    }
  }

  if (isEditing) {
    return (
      <input
        autoFocus
        aria-label={ariaLabel}
        className={cn(
          'w-full rounded-sm border border-input bg-background px-1 py-0.5 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
          inputClassName,
        )}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (revertedRef.current) return;
          commit();
        }}
      />
    );
  }

  return (
    <span
      role="textbox"
      tabIndex={0}
      aria-label={ariaLabel}
      className={cn('cursor-text truncate', className)}
      onDoubleClick={startEditing}
      onKeyDown={(event) => {
        if (event.key === 'Enter') startEditing();
      }}
    >
      {value}
    </span>
  );
}
