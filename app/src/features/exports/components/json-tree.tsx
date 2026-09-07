import { cn } from '@/lib/utils';

interface JsonTreeProps {
  value: unknown;
  /** Root nodes open by default; nested ones start collapsed so a large audit report doesn't dump every issue open at once. */
  depth?: number;
  className?: string;
}

function valueClassName(value: unknown): string {
  if (typeof value === 'string') return 'text-emerald-600 dark:text-emerald-400';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return 'text-sky-600 dark:text-sky-400';
  }
  if (value === null) return 'text-muted-foreground italic';
  return '';
}

function formatPrimitive(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

/**
 * Minimal, dependency-free JSON tree viewer (no `collapsible`/tree component exists in
 * `src/components/ui` yet, and this is used in exactly one place) — plain nested `<details>`
 * elements, which gives free keyboard/accessibility support without pulling in Radix.
 */
export function JsonTree({ value, depth = 0, className }: JsonTreeProps) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-muted-foreground italic">[]</span>;
    }
    return (
      <ul className={cn('space-y-0.5', depth > 0 && 'ml-4 border-l pl-3', className)}>
        {value.map((item, index) => (
          <li key={index}>
            {isExpandable(item) ? (
              <details open={depth < 1}>
                <summary className="cursor-pointer text-muted-foreground select-none">
                  [{index}] {previewOf(item)}
                </summary>
                <JsonTree value={item} depth={depth + 1} />
              </details>
            ) : (
              <span>
                <span className="text-muted-foreground">[{index}] </span>
                <span className={valueClassName(item)}>{formatPrimitive(item)}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    );
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return <span className="text-muted-foreground italic">{'{}'}</span>;
    }
    return (
      <ul className={cn('space-y-0.5', depth > 0 && 'ml-4 border-l pl-3', className)}>
        {entries.map(([key, item]) => (
          <li key={key}>
            {isExpandable(item) ? (
              <details open={depth < 1}>
                <summary className="cursor-pointer text-foreground select-none">
                  <span className="font-medium">{key}</span>{' '}
                  <span className="text-muted-foreground">{previewOf(item)}</span>
                </summary>
                <JsonTree value={item} depth={depth + 1} />
              </details>
            ) : (
              <span>
                <span className="font-medium text-foreground">{key}</span>
                <span className="text-muted-foreground">: </span>
                <span className={valueClassName(item)}>{formatPrimitive(item)}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return <span className={valueClassName(value)}>{formatPrimitive(value)}</span>;
}

function isExpandable(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

function previewOf(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).length}}`;
  }
  return '';
}
