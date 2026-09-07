import { cn } from '@/lib/utils';

interface PaneStatusBarProps {
  children: React.ReactNode;
  className?: string;
}

/** The `h-8` status strip at the bottom of a studio pane. */
export function PaneStatusBar({ children, className }: PaneStatusBarProps) {
  return (
    <div
      className={cn(
        'flex h-8 shrink-0 items-center gap-2 border-t px-3 text-xs text-muted-foreground',
        className,
      )}
    >
      {children}
    </div>
  );
}
