import { Sparkles } from 'lucide-react';

import type { Source } from '@/api/types';
import { Checkbox } from '@/components/ui/checkbox';
import { SourceActionsMenu } from '@/features/sources/components/source-actions-menu';
import { SourceStatusDot } from '@/features/sources/components/source-status-dot';
import { SourceTypeTile } from '@/features/sources/components/source-type-tile';
import { formatBytes, formatDate } from '@/features/sources/lib/source-format';

interface SourceRowProps {
  source: Source;
  citationCount: number;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  onEdit: () => void;
  onDetach: () => void;
}

/** One line of the sources table; column widths come from the `<colgroup>` in `SourcesDialog`. */
export function SourceRow({
  source,
  citationCount,
  selected,
  onSelectedChange,
  onEdit,
  onDetach,
}: SourceRowProps) {
  const authorsLabel = source.authors
    ? `${source.authors}${source.year ? ` (${source.year})` : ''}`
    : '—';

  return (
    <tr
      data-selected={selected || undefined}
      className="hover:bg-muted/30 data-selected:bg-accent/40"
    >
      <td className="py-1.5 pr-1 pl-3">
        <Checkbox
          checked={selected}
          onCheckedChange={(checked) => onSelectedChange(checked === true)}
          aria-label={`Select ${source.name}`}
        />
      </td>
      <td className="overflow-hidden py-1.5 pr-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <SourceTypeTile type={source.type} />
          <span className="truncate text-xs font-medium text-foreground" title={source.name}>
            {source.name}
          </span>
        </div>
      </td>
      <td className="overflow-hidden py-1.5 pr-3 text-[11px] text-muted-foreground">
        <span className="block truncate" title={authorsLabel}>
          {authorsLabel}
        </span>
      </td>
      <td className="py-1.5 pr-3 text-right font-mono text-[11px] whitespace-nowrap text-muted-foreground">
        {formatBytes(source.sizeBytes)}
      </td>
      <td className="py-1.5 pr-3 text-[11px] whitespace-nowrap text-muted-foreground">
        {formatDate(source.uploadDate)}
      </td>
      <td className="py-1.5 pr-3">
        <SourceStatusDot source={source} />
      </td>
      <td className="py-1.5 pr-3 text-right text-[11px]" title="Linked citations">
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Sparkles className="size-3 text-warning" />
          {citationCount}
        </span>
      </td>
      <td className="py-1.5 pr-2 text-right">
        <SourceActionsMenu source={source} onEdit={onEdit} onDetach={onDetach} />
      </td>
    </tr>
  );
}
