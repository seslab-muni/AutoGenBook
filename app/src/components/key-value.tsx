import { cn } from '@/lib/utils';

interface KeyValueProps {
  label: string;
  value: React.ReactNode;
  className?: string;
}

/** A label/value metric pair, value rendered in the app's mono font. */
export function KeyValue({ label, value, className }: KeyValueProps) {
  return (
    <div className={cn('flex items-center justify-between gap-3 text-xs', className)}>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  );
}
