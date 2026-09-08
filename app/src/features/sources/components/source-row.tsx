import { Sparkles } from 'lucide-react';

import type { Source } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { SourceActionsMenu } from '@/features/sources/components/source-actions-menu';
import { SourceStatusDot } from '@/features/sources/components/source-status-dot';
import { formatBytes, formatDate, SOURCE_TYPE_LABELS } from '@/features/sources/lib/source-format';

interface SourceRowProps {
  source: Source;
  citationCount: number;
  onEdit: () => void;
  onDetach: () => void;
}

export function SourceRow({ source, citationCount, onEdit, onDetach }: SourceRowProps) {
  const authorsLabel = source.authors
    ? `${source.authors}${source.year ? ` (${source.year})` : ''}`
    : '—';

  return (
    <tr className="border-b last:border-0 hover:bg-muted/30">
      <td className="overflow-hidden py-2 pr-3 pl-3">
        <div className="truncate text-xs font-medium text-foreground" title={source.name}>
          {source.name}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">{authorsLabel}</div>
      </td>
      <td className="py-2 pr-3">
        <Badge variant="secondary">{SOURCE_TYPE_LABELS[source.type]}</Badge>
      </td>
      <td className="py-2 pr-3 text-[11px] whitespace-nowrap text-muted-foreground">
        {formatBytes(source.sizeBytes)}
      </td>
      <td className="py-2 pr-3 text-[11px] whitespace-nowrap text-muted-foreground">
        {formatDate(source.uploadDate)}
      </td>
      <td className="py-2 pr-3">
        <SourceStatusDot source={source} />
      </td>
      <td className="py-2 pr-3 text-[11px]" title="Linked citations">
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Sparkles className="size-3 text-warning" />
          {citationCount}
        </span>
      </td>
      <td className="py-2 pr-3 text-right">
        <SourceActionsMenu source={source} onEdit={onEdit} onDetach={onDetach} />
      </td>
    </tr>
  );
}
