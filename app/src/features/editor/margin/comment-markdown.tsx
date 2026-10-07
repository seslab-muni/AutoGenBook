import { lazy, Suspense } from 'react';

import { cn } from '@/lib/utils';

// `react-markdown` and `remark-gfm` are heavy and shared with the manuscript view's chunk: load them
// when the first comment is shown rather than with the editor sheet.
const Impl = lazy(() => import('./comment-markdown-impl'));

/** A comment's Markdown body (GFM, no HTML); plain text while the renderer loads. */
export function CommentMarkdown({
  children,
  className,
}: {
  children: string;
  className?: string | undefined;
}) {
  return (
    <Suspense
      fallback={
        <div className={cn('text-sm leading-snug break-words whitespace-pre-wrap', className)}>
          {children}
        </div>
      }
    >
      <Impl className={className}>{children}</Impl>
    </Suspense>
  );
}
