import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '@/lib/utils';

const COMPONENTS: Components = {
  a: ({ node, className, ...props }) => {
    void node;
    return (
      <a
        {...props}
        target="_blank"
        rel="noopener noreferrer"
        className={cn('text-primary underline underline-offset-2', className)}
      />
    );
  },
  img: ({ alt }) => <span className="text-muted-foreground">[image: {alt ?? ''}]</span>,
  p: ({ node, ...props }) => {
    void node;
    return <p className="my-1 first:mt-0 last:mb-0" {...props} />;
  },
  ul: ({ node, ...props }) => {
    void node;
    return <ul className="my-1 ml-4 list-disc" {...props} />;
  },
  ol: ({ node, ...props }) => {
    void node;
    return <ol className="my-1 ml-4 list-decimal" {...props} />;
  },
  code: ({ node, ...props }) => {
    void node;
    return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]" {...props} />;
  },
  pre: ({ node, ...props }) => {
    void node;
    return (
      <pre
        className="custom-scrollbar my-1 overflow-x-auto rounded bg-muted p-2 text-xs"
        {...props}
      />
    );
  },
  blockquote: ({ node, ...props }) => {
    void node;
    return <blockquote className="my-1 border-l-2 pl-2 text-muted-foreground" {...props} />;
  },
};

/**
 * A comment's Markdown body. Deliberately small (GFM, no HTML, no images, no headings styling):
 * the default `react-markdown` pipeline escapes raw HTML, so nothing a collaborator types can
 * inject markup.
 */
export default function CommentMarkdownImpl({
  children,
  className,
}: {
  children: string;
  className?: string | undefined;
}) {
  return (
    <div className={cn('text-sm leading-snug break-words', className)}>
      <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS} skipHtml>
        {children}
      </Markdown>
    </div>
  );
}
