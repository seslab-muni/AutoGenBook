import { useEffect, useRef, useState } from 'react';

import type { RunEvent } from '@/api/types';
import { EmptyState } from '@/components/empty-state';
import { Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { levelColorClass, stageColorClass } from '@/features/runs/lib/run-format';

interface RunEventLogProps {
  events: RunEvent[];
  className?: string;
  emptyMessage?: string;
}

/**
 * Scrolling event log for a run's `log`/`stage`/`section`/`done` stream.
 * Auto-scrolls to the newest event, pausing while the pointer is over the
 * list so the reader can inspect older lines without fighting new ones.
 * Not virtualised: the mock's simulated runs top out at a few dozen events;
 * revisit with a windowed list (e.g. `@tanstack/react-virtual`) if real CLI
 * runs turn out to emit large event volumes.
 */
export function RunEventLog({ events, className, emptyMessage }: RunEventLogProps) {
  const [paused, setPaused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (paused) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events, paused]);

  if (events.length === 0) {
    return (
      <EmptyState
        icon={Terminal}
        title="No activity yet"
        description={emptyMessage ?? 'Events appear here once the run starts.'}
        {...(className ? { className } : {})}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      role="log"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={cn('space-y-1 overflow-y-auto font-mono text-[11px] leading-relaxed', className)}
    >
      {events.map((event) => (
        <div
          key={event.seq}
          className="flex items-start gap-2 rounded px-1.5 py-0.5 hover:bg-muted/50"
        >
          <span className="shrink-0 text-muted-foreground/70">
            {new Date(event.ts).toLocaleTimeString(undefined, {
              hour12: false,
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </span>
          {event.stage ? (
            <span
              className={cn(
                'shrink-0 rounded bg-muted px-1 py-0 text-[10px] font-semibold uppercase',
                stageColorClass(event.stage),
              )}
            >
              {event.stage}
            </span>
          ) : null}
          <span className={cn('min-w-0 flex-1 break-words', levelColorClass(event.level))}>
            {event.message}
          </span>
        </div>
      ))}
    </div>
  );
}
