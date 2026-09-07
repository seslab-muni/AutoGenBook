import 'katex/dist/katex.min.css';

import { useMemo } from 'react';
import Markdown, { type Components, type ExtraProps } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

import { apiBaseUrl } from '@/api/client';
import type { RAGCitation } from '@/api/types';
import { Callout } from '@/features/editor/components/callout';
import { CitationChip } from '@/features/editor/components/citation-chip';
import { normalizeDisplayMath } from '@/features/editor/lib/normalize-display-math';
import { remarkCallouts, remarkCitations } from '@/features/editor/lib/remark-plugins';
import { mathAwareSchema } from '@/features/editor/lib/sanitize-schema';
import { cn } from '@/lib/utils';

const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkCitations, remarkCallouts];
const REHYPE_PLUGINS: NonNullable<React.ComponentProps<typeof Markdown>['rehypePlugins']> = [
  [rehypeKatex, { output: 'htmlAndMathml', throwOnError: false, strict: false }],
  [rehypeSanitize, mathAwareSchema],
];

/** Absolute/data/protocol-relative URLs pass through; anything else is a run artifact file id. */
function resolveImageSrc(src: string): string {
  if (/^(https?:)?\/\//.test(src) || src.startsWith('data:') || src.startsWith('blob:')) {
    return src;
  }
  return `${apiBaseUrl}/api/v1/files/${src}/content`;
}

/**
 * `react-markdown` passes the originating hast/mdast `node` to every
 * component override (`ExtraProps`) for introspection; none of the DOM
 * elements below want it forwarded as a prop, so this drops it in one place
 * instead of a `node: _node` destructure repeated in every override below.
 */
function withoutNode<P extends ExtraProps>(props: P): Omit<P, 'node'> {
  const { node, ...rest } = props;
  void node;
  return rest;
}

interface MarkdownViewProps {
  /** Pandoc-style Markdown, as written by the CLI's Markdown-first path (`book_builder.py`). */
  markdown: string;
  /** Looked up by citekey (matched against `RAGCitation.id`) to label/resolve `[@key]`/`\cite{key}` chips. */
  citations?: readonly RAGCitation[];
  /** Called with a citekey when its chip is clicked; omit to render chips as inert labels. */
  onCitationClick?: (citeKey: string) => void;
  className?: string;
}

/**
 * Renders CLI-generated section Markdown: GFM (tables, strikethrough, task
 * lists) + `$…$`/`$$…$$` math (KaTeX) + theorem/definition/lemma/proof/example
 * callouts + clickable citation chips, sanitized against a math-aware schema
 * (`mathAwareSchema`) so no raw HTML the LLM emits can inject a script or
 * event handler.
 */
export function MarkdownView({
  markdown,
  citations,
  onCitationClick,
  className,
}: MarkdownViewProps) {
  const citationsById = useMemo(() => {
    const map = new Map<string, RAGCitation>();
    for (const citation of citations ?? []) map.set(citation.id, citation);
    return map;
  }, [citations]);

  const components = useMemo<Components>(
    () => ({
      span(props) {
        const { citekey, children, ...rest } = withoutNode(props) as ReturnType<
          typeof withoutNode<typeof props>
        > & { citekey?: string };
        if (typeof citekey !== 'string') return <span {...rest}>{children}</span>;
        return (
          <CitationChip
            citeKey={citekey}
            citation={citationsById.get(citekey)}
            onClick={onCitationClick}
          />
        );
      },
      blockquote(props) {
        const { calloutkind, calloutlabel, children, ...rest } = withoutNode(props) as ReturnType<
          typeof withoutNode<typeof props>
        > & { calloutkind?: string; calloutlabel?: string };
        if (typeof calloutkind !== 'string') {
          return (
            <blockquote
              {...rest}
              className="my-3 border-l-2 border-muted-foreground/30 pl-4 text-sm text-muted-foreground italic"
            >
              {children}
            </blockquote>
          );
        }
        return <Callout label={calloutlabel ?? calloutkind}>{children}</Callout>;
      },
      h1(props) {
        const { className: c, ...rest } = withoutNode(props);
        return (
          <h1
            className={cn('mt-6 mb-3 font-serif text-2xl font-bold tracking-tight', c)}
            {...rest}
          />
        );
      },
      h2(props) {
        const { className: c, ...rest } = withoutNode(props);
        return (
          <h2
            className={cn('mt-5 mb-2 font-serif text-xl font-semibold tracking-tight', c)}
            {...rest}
          />
        );
      },
      h3(props) {
        const { className: c, ...rest } = withoutNode(props);
        return <h3 className={cn('mt-4 mb-2 font-serif text-lg font-medium', c)} {...rest} />;
      },
      p(props) {
        const { className: c, ...rest } = withoutNode(props);
        return <p className={cn('my-2.5 leading-relaxed', c)} {...rest} />;
      },
      ul(props) {
        const { className: c, ...rest } = withoutNode(props);
        return <ul className={cn('my-2 ml-5 list-disc space-y-1', c)} {...rest} />;
      },
      ol(props) {
        const { className: c, ...rest } = withoutNode(props);
        return <ol className={cn('my-2 ml-5 list-decimal space-y-1', c)} {...rest} />;
      },
      a(props) {
        const { className: c, ...rest } = withoutNode(props);
        return <a className={cn('text-primary underline underline-offset-2', c)} {...rest} />;
      },
      hr(props) {
        const { className: c, ...rest } = withoutNode(props);
        return <hr className={cn('my-6 border-border', c)} {...rest} />;
      },
      table(props) {
        const { className: c, ...rest } = withoutNode(props);
        return (
          <div className="my-3 overflow-x-auto rounded-md border">
            <table className={cn('w-full border-collapse text-sm', c)} {...rest} />
          </div>
        );
      },
      th(props) {
        const { className: c, ...rest } = withoutNode(props);
        return (
          <th
            className={cn('border-b bg-muted/50 px-3 py-1.5 text-left font-semibold', c)}
            {...rest}
          />
        );
      },
      td(props) {
        const { className: c, ...rest } = withoutNode(props);
        return <td className={cn('border-b px-3 py-1.5 align-top', c)} {...rest} />;
      },
      pre(props) {
        const { className: c, ...rest } = withoutNode(props);
        return (
          <pre
            className={cn(
              'my-3 overflow-x-auto rounded-lg border bg-muted p-3 font-mono text-xs leading-relaxed',
              c,
            )}
            {...rest}
          />
        );
      },
      code(props) {
        const { className: c, children, ...rest } = withoutNode(props);
        const isBlock = typeof c === 'string' && c.startsWith('language-');
        if (isBlock) {
          return (
            <code className={cn('font-mono text-xs', c)} {...rest}>
              {children}
            </code>
          );
        }
        return (
          <code className={cn('rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]', c)} {...rest}>
            {children}
          </code>
        );
      },
      img(props) {
        const { src, alt, className: c, ...rest } = withoutNode(props);
        return (
          <img
            src={typeof src === 'string' ? resolveImageSrc(src) : src}
            alt={alt ?? ''}
            className={cn('my-3 max-w-full rounded-md border', c)}
            {...rest}
          />
        );
      },
    }),
    [citationsById, onCitationClick],
  );

  return (
    <div className={cn('text-sm text-foreground', className)}>
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
      >
        {normalizeDisplayMath(markdown)}
      </Markdown>
    </div>
  );
}
