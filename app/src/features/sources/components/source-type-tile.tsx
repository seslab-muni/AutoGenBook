import type { SourceType } from '@/api/types';
import { SOURCE_TYPE_LABELS } from '@/features/sources/lib/source-format';
import { cn } from '@/lib/utils';

const TYPE_ABBREVIATIONS: Record<SourceType, string> = {
  pdf: 'PDF',
  doc: 'DOC',
  ppt: 'PPT',
  md: 'MD',
  txt: 'TXT',
  slides: 'PPT',
  arxiv: 'ARX',
  notes: 'NOTE',
  bibtex: 'BIB',
  latex: 'TEX',
  url: 'URL',
  book: 'BOOK',
  dataset: 'DATA',
};

/** Tinted per file family the same way `run-format.ts` tints pipeline stages: a fixed palette
 * colour with a lighter dark-mode variant, since the theme's semantic tokens (`info`,
 * `warning`) are too light for 9px bold text on a tinted chip. */
const TYPE_CLASSES: Partial<Record<SourceType, string>> = {
  pdf: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
  doc: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  ppt: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  slides: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  md: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
  latex: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
};

interface SourceTypeTileProps {
  type: SourceType;
  className?: string;
}

/** Small square "PDF" / "MD" glyph that identifies a source's file family at a glance. */
export function SourceTypeTile({ type, className }: SourceTypeTileProps) {
  return (
    <span
      title={SOURCE_TYPE_LABELS[type]}
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-md text-[9px] font-bold tracking-wide',
        TYPE_CLASSES[type] ?? 'bg-muted text-muted-foreground',
        className,
      )}
    >
      {TYPE_ABBREVIATIONS[type]}
    </span>
  );
}
