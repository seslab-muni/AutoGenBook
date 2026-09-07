import { cn } from '@/lib/utils';
import type { NodeStatus } from '@/api/types';

const STATUS_LABEL: Record<NodeStatus, string> = {
  not_started: 'Not started',
  drafting: 'Drafting',
  review_ready: 'Review ready',
  compiled: 'Compiled',
};

const STATUS_CLASSES: Record<NodeStatus, string> = {
  not_started: 'bg-muted text-muted-foreground',
  drafting: 'bg-warning/15 text-warning',
  review_ready: 'bg-info/15 text-info',
  compiled: 'bg-success/15 text-success',
};

interface StatusBadgeProps {
  status: NodeStatus;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex w-fit shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        STATUS_CLASSES[status],
        className,
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
