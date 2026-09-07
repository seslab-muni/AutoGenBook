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
  className?: string;
}

export function SaveStatusBadge({ status, className }: SaveStatusBadgeProps) {
  const Icon = ICONS[status];
  return (
    <span
      className={cn('flex items-center gap-1 text-xs font-medium', COLORS[status], className)}
      role="status"
    >
      <Icon className={cn('size-3', status === 'saving' && 'animate-spin')} />
      {SAVE_STATUS_LABEL[status]}
    </span>
  );
}
