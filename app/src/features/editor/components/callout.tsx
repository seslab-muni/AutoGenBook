import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface CalloutProps {
  label: string;
  children?: ReactNode;
  className?: string;
}

/**
 * A blockquote starting with `**Theorem**`/`**Lemma**`/`**Definition**`/
 * `**Proof**`/`**Example**` (see `remarkCallouts`) renders as this indigo
 * left-border card instead of a plain blockquote.
 */
export function Callout({ label, children, className }: CalloutProps) {
  return (
    <div
      className={cn(
        'my-4 rounded-xl border-l-4 border-indigo-600 bg-indigo-50/70 p-4 text-foreground shadow-xs dark:bg-indigo-500/10',
        className,
      )}
    >
      <div className="mb-1 flex items-center gap-1.5 font-sans text-xs font-semibold tracking-wide text-indigo-900 uppercase dark:text-indigo-300">
        <span className="size-2 rounded-full bg-indigo-600 dark:bg-indigo-400" />
        {label}
      </div>
      <div className="font-serif text-sm leading-relaxed text-foreground/90 italic [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
        {children}
      </div>
    </div>
  );
}
