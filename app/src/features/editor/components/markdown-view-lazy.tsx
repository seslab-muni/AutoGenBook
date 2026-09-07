import { lazy, Suspense } from 'react';

import { Skeleton } from '@/components/ui/skeleton';

// `MarkdownView` pulls in `react-markdown` + remark/rehype plugins + KaTeX — kept out of the
// Copilot drawer's (eagerly-loaded, part of the studio route) bundle by loading it lazily here.
// `ManuscriptSheet` (itself already behind its own lazy boundary, see `editor-pane.tsx`) imports
// the real `MarkdownView` directly; Rollup factors the shared module out into one async chunk
// used by both lazy entry points, rather than duplicating it or pulling it into the eager route.
const MarkdownView = lazy(() =>
  import('@/features/editor/components/markdown-view').then((m) => ({ default: m.MarkdownView })),
);

type MarkdownViewProps = React.ComponentProps<typeof MarkdownView>;

export function LazyMarkdownView(props: MarkdownViewProps) {
  return (
    <Suspense fallback={<Skeleton className="h-24 w-full" />}>
      <MarkdownView {...props} />
    </Suspense>
  );
}
