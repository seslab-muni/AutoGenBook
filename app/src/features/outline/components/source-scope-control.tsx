import { useRef, type KeyboardEvent } from 'react';

import type { SourceScope } from '@/api/types';
import { cn } from '@/lib/utils';

export interface SourceScopeOption {
  value: SourceScope;
  label: string;
}

interface SourceScopeControlProps {
  options: readonly SourceScopeOption[];
  value: SourceScope;
  onChange: (value: SourceScope) => void;
  'aria-label': string;
  disabled?: boolean;
  className?: string;
}

/**
 * Segmented `radiogroup` for a node's source scope — a roving-tabindex radio set (arrow keys
 * move and select, like native radios) styled as one pill track. Hand-rolled since the shadcn
 * set here has no radio-group/toggle-group primitive.
 */
export function SourceScopeControl({
  options,
  value,
  onChange,
  disabled = false,
  className,
  'aria-label': ariaLabel,
}: SourceScopeControlProps) {
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (activeIndex + step + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    buttonsRef.current[next]?.focus();
    onChange(option.value);
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className={cn('flex rounded-lg bg-muted p-0.5', className)}
    >
      {options.map((option, index) => {
        const checked = index === activeIndex;
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttonsRef.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'min-w-0 flex-1 truncate rounded-md px-2 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50',
              checked
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
