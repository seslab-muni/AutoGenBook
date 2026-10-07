import { AlertCircle, Check, Loader2, Pencil } from 'lucide-react';

import { SAVE_STATUS_LABEL, type SaveStatus } from '@/features/editor/lib/save-status';
import { cn } from '@/lib/utils';

const ICONS: Record<SaveStatus, typeof Check> = {
  idle: Check,
  saved: Check,
  dirty: Pencil,
  saving: Loader2,
  error: AlertCircle,
};

const COLORS: Record<SaveStatus, string> = {
  idle: 'text-success',
  saved: 'text-success',
  dirty: 'text-muted-foreground',
  saving: 'text-muted-foreground',
  error: 'text-destructive',
};

interface SaveStatusBadgeProps {
  status: SaveStatus;
  /** Collapses the label to the icon below the `xl` breakpoint (it stays available to screen readers). */
  collapsible?: boolean;
  className?: string;
}

export function SaveStatusBadge({ status, collapsible = false, className }: SaveStatusBadgeProps) {
  const Icon = ICONS[status];
  return (
    <span
      className={cn('flex items-center gap-1 text-xs font-medium', COLORS[status], className)}
      role="status"
    >
      <Icon className={cn('size-3', status === 'saving' && 'animate-spin')} />
      <span className={collapsible ? 'max-xl:sr-only' : undefined}>
        {SAVE_STATUS_LABEL[status]}
      </span>
    </span>
  );
}
