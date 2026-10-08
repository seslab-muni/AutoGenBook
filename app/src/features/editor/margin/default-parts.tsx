import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { MarginCardPartProps } from './card-registry';

/** Default header status: where the card points and whether it is finished with. */
export function DefaultStatus({ thread, approximate }: MarginCardPartProps) {
  return (
    <>
      {thread.orphaned ? <Badge variant="outline">Orphaned</Badge> : null}
      {thread.sectionLevel ? <Badge variant="outline">Whole section</Badge> : null}
      {approximate && !thread.orphaned ? (
        <Badge variant="outline">Not shown in this view</Badge>
      ) : null}
      {thread.status === 'resolved' ? <Badge variant="secondary">Resolved</Badge> : null}
    </>
  );
}

/** Default quote area: the quoted text, struck through when orphaned. */
export function DefaultQuote({ thread }: MarginCardPartProps) {
  return (
    <>
      {!thread.sectionLevel && thread.quote ? (
        <blockquote
          className={cn(
            'mb-2 line-clamp-3 border-l-2 pl-2 text-xs text-muted-foreground italic',
            thread.orphaned && 'line-through decoration-muted-foreground/60',
          )}
        >
          {thread.quote}
        </blockquote>
      ) : null}
      {thread.orphaned ? (
        <p className="mb-2 text-[11px] text-muted-foreground">
          The text this refers to is gone from the section.
        </p>
      ) : null}
    </>
  );
}
