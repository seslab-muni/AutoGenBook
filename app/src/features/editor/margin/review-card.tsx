import { useState } from 'react';
import { ArrowRight, CircleAlert, TriangleAlert, Wrench } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  reviewPayload,
  reviewTypeLabel,
  type ReviewPayload,
} from '@/features/editor/lib/card-payloads';
import type { MarginCardPartProps } from './card-registry';
import { CommentCardBody } from './comment-card-body';

const SOURCE_LABELS: Record<ReviewPayload['source'], string> = {
  reviewer: 'Reviewer',
  consistency: 'Consistency check',
  citation: 'Citation check',
};

/**
 * Header status of a review card (issue #164's pills, built once here in the margin): the severity
 * (Major with a warning triangle, Minor with a circle, so the two differ by shape and word as well
 * as tint), the issue type, and Outdated / Dismissed markers.
 */
export function ReviewStatus({ thread, approximate }: MarginCardPartProps) {
  const payload = reviewPayload(thread.root);
  const major = payload.severity === 'major';
  const Icon = major ? TriangleAlert : CircleAlert;
  return (
    <>
      {thread.orphaned ? <Badge variant="outline">Orphaned</Badge> : null}
      {thread.sectionLevel ? <Badge variant="outline">Whole section</Badge> : null}
      {approximate && !thread.orphaned ? (
        <Badge variant="outline">Not shown in this view</Badge>
      ) : null}
      <Badge
        variant="outline"
        data-severity={payload.severity}
        className={cn(
          'text-foreground',
          major ? 'border-destructive/50 bg-destructive/15' : 'border-warning/60 bg-warning/20',
        )}
      >
        <Icon aria-hidden="true" />
        {major ? 'Major' : 'Minor'}
      </Badge>
      <Badge variant="secondary" className="max-w-40 truncate" title={payload.type}>
        {reviewTypeLabel(payload.type)}
      </Badge>
      {payload.outdated ? (
        <Badge
          variant="outline"
          title="A newer review no longer reports this issue; it is kept because it has replies."
        >
          Outdated
        </Badge>
      ) : null}
      {thread.status === 'resolved' && !payload.outdated ? (
        <Badge variant="secondary">Dismissed</Badge>
      ) : null}
    </>
  );
}

const CLAMP_AT = 220;

/** Long text shows a few lines and "Show more", so one issue cannot take the whole margin. */
function ClampedText({ text, className }: { text: string; className: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > CLAMP_AT;
  return (
    <>
      <p className={cn(className, long && !open && 'line-clamp-4')}>{text}</p>
      {long ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto self-start p-0 text-[11px] text-foreground"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Show less' : 'Show more'}
        </Button>
      ) : null}
    </>
  );
}

/**
 * Body of a review card: the issue's description, the required fix in an inset, the literal
 * replacement (only when the reviewer gave both halves), where it came from, then the shared
 * thread controls (replies, Fix with Copilot, Dismiss).
 */
export function ReviewCardBody(props: MarginCardPartProps) {
  const { thread } = props;
  const payload = reviewPayload(thread.root);
  const hasReplacement = payload.replaceFrom !== '' && payload.replaceTo !== '';
  return (
    <div className="flex flex-col gap-2">
      <ClampedText
        text={thread.root.bodyMarkdown}
        className="text-sm leading-snug break-words whitespace-pre-wrap"
      />
      {payload.requiredFix ? (
        <div className="rounded-md bg-muted p-2">
          <p className="mb-1 flex items-center gap-1 text-[10px] font-bold tracking-wide text-foreground uppercase">
            <Wrench className="size-3" aria-hidden="true" />
            Required fix
          </p>
          <ClampedText
            text={payload.requiredFix}
            className="text-xs leading-snug break-words whitespace-pre-wrap"
          />
        </div>
      ) : null}
      {hasReplacement ? (
        <p
          className="flex flex-wrap items-center gap-1.5 font-mono text-xs"
          aria-label={`Replace “${payload.replaceFrom}” with “${payload.replaceTo}”`}
        >
          <span className="rounded border border-destructive/40 bg-destructive/15 px-1.5 py-0.5 break-words text-foreground line-through decoration-destructive">
            {payload.replaceFrom}
          </span>
          <ArrowRight className="size-3 text-muted-foreground" aria-hidden="true" />
          <span className="rounded border border-success/50 bg-success/15 px-1.5 py-0.5 break-words text-foreground underline decoration-success decoration-2 underline-offset-2">
            {payload.replaceTo}
          </span>
        </p>
      ) : null}
      <p className="text-[11px] text-muted-foreground">{SOURCE_LABELS[payload.source]}</p>
      <CommentCardBody {...props} variant="review" />
    </div>
  );
}
