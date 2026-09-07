import { cn } from '@/lib/utils';

interface PaneToolbarProps {
  children: React.ReactNode;
  className?: string;
}

/** The `h-11` toolbar strip at the top of a studio pane. */
export function PaneToolbar({ children, className }: PaneToolbarProps) {
  return (
    <div
      className={cn(
        'flex h-11 shrink-0 items-center justify-between gap-2 border-b px-3',
        className,
      )}
    >
      {children}
    </div>
  );
}
