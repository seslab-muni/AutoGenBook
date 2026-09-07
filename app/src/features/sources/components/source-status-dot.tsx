import type { Source } from '@/api/types';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SOURCE_STATUS_PRESENTATION } from '@/features/sources/lib/source-status';
import { cn } from '@/lib/utils';

interface SourceStatusDotProps {
  source: Pick<Source, 'status' | 'chunksCount'>;
  className?: string;
}

/** Grey/green/red dot + label for a source's indexing status, matching the three states
 * `chunksCount`/`status` can hold (`ready` until a run indexes it — issue #10). */
export function SourceStatusDot({ source, className }: SourceStatusDotProps) {
  const presentation = SOURCE_STATUS_PRESENTATION[source.status];
  const label =
    source.status === 'indexed' && source.chunksCount != null
      ? `Indexed (${source.chunksCount} chunks)`
      : presentation.label;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 text-[11px] font-medium',
            className,
            presentation.textClassName,
          )}
        >
          <span className={cn('size-1.5 shrink-0 rounded-full', presentation.dotClassName)} />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{presentation.hint}</TooltipContent>
    </Tooltip>
  );
}
