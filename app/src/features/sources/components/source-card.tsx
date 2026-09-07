import { Sparkles } from 'lucide-react';

import type { Source } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { SourceActionsMenu } from '@/features/sources/components/source-actions-menu';
import { SourceStatusDot } from '@/features/sources/components/source-status-dot';
import { formatBytes, SOURCE_TYPE_LABELS } from '@/features/sources/lib/source-format';

interface SourceCardProps {
  source: Source;
  citationCount: number;
  onEdit: () => void;
  onDetach: () => void;
}

export function SourceCard({ source, citationCount, onEdit, onDetach }: SourceCardProps) {
  return (
    <Card className="gap-3 py-3.5">
      <CardHeader className="px-3.5">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <h4 className="truncate text-xs font-semibold text-card-foreground" title={source.name}>
              {source.name}
            </h4>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {source.authors
                ? `${source.authors}${source.year ? ` (${source.year})` : ''}`
                : 'No authors listed'}
            </p>
          </div>
          <SourceActionsMenu source={source} onEdit={onEdit} onDetach={onDetach} />
        </div>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-2 px-3.5 text-[11px]">
        <div className="flex min-w-0 items-center gap-1.5">
          <Badge variant="secondary">{SOURCE_TYPE_LABELS[source.type]}</Badge>
          <span className="text-muted-foreground">{formatBytes(source.sizeBytes)}</span>
        </div>
        <span
          title="Linked citations"
          className="flex shrink-0 items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 font-medium text-muted-foreground"
        >
          <Sparkles className="size-3 text-warning" />
          {citationCount}
        </span>
      </CardContent>
      <div className="border-t px-3.5 pt-2.5">
        <SourceStatusDot source={source} />
      </div>
    </Card>
  );
}
