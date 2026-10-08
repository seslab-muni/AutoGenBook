import 'katex/dist/katex.min.css';

import { createContext, memo, useContext, useEffect, useMemo, useRef } from 'react';
import Markdown, { type Components, type ExtraProps } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

import { Callout } from '@/features/editor/components/callout';
import { CitationChip } from '@/features/editor/components/citation-chip';
import { resolveImageSrc } from '@/features/editor/lib/resolve-image-src';
import { normalizeDisplayMathMapped } from '@/features/editor/lib/normalize-display-math';
import type { RagCitation } from '@/features/editor/lib/rag-citation';
import {
  rehypeAnchorSource,
  rehypeMathPositions,
  type AnchorMark,
} from '@/features/editor/lib/rehype-anchor-source';
import { remarkCallouts, remarkCitations } from '@/features/editor/lib/remark-plugins';
import {
  applyWriteHighlights,
  highlightIdsAtPoint,
  supportsCustomHighlights,
} from '@/features/editor/lib/write-highlights';
import { mathAwareSchema } from '@/features/editor/lib/sanitize-schema';
import { cn } from '@/lib/utils';

const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkCitations, remarkCallouts];
type RehypePlugins = NonNullable<React.ComponentProps<typeof Markdown>['rehypePlugins']>;
const KATEX_PLUGIN: RehypePlugins[number] = [
  rehypeKatex,
  { output: 'htmlAndMathml', throwOnError: false, strict: false },
];
const BASE_REHYPE_PLUGINS: RehypePlugins = [KATEX_PLUGIN, [rehypeSanitize, mathAwareSchema]];
/**
 * For the editable view's formulas: the HTML rendering only (the MathML copy roughly doubles the
 * DOM of a formula, and the atom carries its own accessible name), so a section with hundreds of
 * formulas stays a document the browser can edit and hit-test quickly.
 */
const INLINE_REHYPE_PLUGINS: RehypePlugins = [
  [rehypeKatex, { output: 'html', throwOnError: false, strict: false }],
  [rehypeSanitize, mathAwareSchema],
];

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

/**
 * What the citation chips need, read through context so the `span` override is one module-level
 * component: a new `citations` array or click handler re-renders the chips but never remounts the
 * text around them (which would drop the reader's selection).
 */
const MarkdownContext = createContext<{
  citationsById: Map<string, RagCitation>;
  onCitationClick: ((citeKey: string) => void) | undefined;
}>({ citationsById: new Map(), onCitationClick: undefined });

/**
 * `remarkCitations` annotates `[@key]`/`\cite{key}` spans with a `citekey` hast property that
 * isn't part of the DOM `span` type, hence the extra field here.
 */
type CitationSpanProps = React.ComponentProps<'span'> &
  ExtraProps & {
    'data-src-start'?: number;
    'data-src-end'?: number;
    'data-src-opaque'?: boolean;
    'data-anchor-ids'?: string;
    'data-anchor-kind'?: string;
    citekey?: string;
  };

function CitationSpan(spanProps: CitationSpanProps) {
  const { citationsById, onCitationClick } = useContext(MarkdownContext);
  const { citekey, children, ...rest } = withoutNode(spanProps);
  if (typeof citekey !== 'string') return <span {...rest}>{children}</span>;
  const chip = (
    <CitationChip
      citeKey={citekey}
      citation={citationsById.get(citekey)}
      onClick={onCitationClick}
    />
  );
  // `rehypeAnchorSource` tags the chip with its source offsets (and, under a comment, the
  // highlight); the chip itself renders no children, so the tags go on a wrapper.
  if (rest['data-src-start'] === undefined) return chip;
  return (
    <span
      data-src-start={rest['data-src-start']}
      data-src-end={rest['data-src-end']}
      data-src-opaque={rest['data-src-opaque']}
      data-anchor-ids={rest['data-anchor-ids']}
      data-anchor-kind={rest['data-anchor-kind']}
      className={cn(rest.className)}
    >
      {chip}
    </span>
  );
}

const Blockquote: NonNullable<Components['blockquote']> = (props) => {
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
};

const H1: NonNullable<Components['h1']> = (props) => {
  const { className: c, ...rest } = withoutNode(props);
  return (
    <h1 className={cn('mt-6 mb-3 font-serif text-2xl font-bold tracking-tight', c)} {...rest} />
  );
};

const H2: NonNullable<Components['h2']> = (props) => {
  const { className: c, ...rest } = withoutNode(props);
  return (
    <h2 className={cn('mt-5 mb-2 font-serif text-xl font-semibold tracking-tight', c)} {...rest} />
  );
};

const H3: NonNullable<Components['h3']> = (props) => {
  const { className: c, ...rest } = withoutNode(props);
  return <h3 className={cn('mt-4 mb-2 font-serif text-lg font-medium', c)} {...rest} />;
};

const P: NonNullable<Components['p']> = (props) => {
  const { className: c, ...rest } = withoutNode(props);
  return <p className={cn('my-2.5 leading-relaxed', c)} {...rest} />;
};

const Ul: NonNullable<Components['ul']> = (props) => {
  const { className: c, ...rest } = withoutNode(props);
  return <ul className={cn('my-2 ml-5 list-disc space-y-1', c)} {...rest} />;
};

const Ol: NonNullable<Components['ol']> = (props) => {
  const { className: c, ...rest } = withoutNode(props);
  return <ol className={cn('my-2 ml-5 list-decimal space-y-1', c)} {...rest} />;
};

const A: NonNullable<Components['a']> = (props) => {
  const { className: c, ...rest } = withoutNode(props);
  return <a className={cn('text-primary underline underline-offset-2', c)} {...rest} />;
};

const Hr: NonNullable<Components['hr']> = (props) => {
  const { className: c, ...rest } = withoutNode(props);
  return <hr className={cn('my-6 border-border', c)} {...rest} />;
};

const Table: NonNullable<Components['table']> = (props) => {
  const { className: c, ...rest } = withoutNode(props);
  return (
    <div className="custom-scrollbar my-3 overflow-x-auto rounded-md border">
      <table className={cn('w-full border-collapse text-sm', c)} {...rest} />
    </div>
  );
};

const Th: NonNullable<Components['th']> = (props) => {
  const { className: c, ...rest } = withoutNode(props);
  return (
    <th className={cn('border-b bg-muted/50 px-3 py-1.5 text-left font-semibold', c)} {...rest} />
  );
};

const Td: NonNullable<Components['td']> = (props) => {
  const { className: c, ...rest } = withoutNode(props);
  return <td className={cn('border-b px-3 py-1.5 align-top', c)} {...rest} />;
};

const Pre: NonNullable<Components['pre']> = (props) => {
  const { className: c, ...rest } = withoutNode(props);
  return (
    <pre
      className={cn(
        'custom-scrollbar my-3 overflow-x-auto rounded-lg border bg-muted p-3 font-mono text-xs leading-relaxed',
        c,
      )}
      {...rest}
    />
  );
};

const Code: NonNullable<Components['code']> = (props) => {
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
};

const Img: NonNullable<Components['img']> = (props) => {
  const { src, alt, className: c, ...rest } = withoutNode(props);
  return (
    <img
      src={typeof src === 'string' ? resolveImageSrc(src) : src}
      alt={alt ?? ''}
      className={cn('my-3 max-w-full rounded-md border', c)}
      {...rest}
    />
  );
};

/** Module-level, so the overrides keep one identity for the life of the page. */
const MARKDOWN_COMPONENTS: Components = {
  span: CitationSpan,
  blockquote: Blockquote,
  h1: H1,
  h2: H2,
  h3: H3,
  p: P,
  ul: Ul,
  ol: Ol,
  a: A,
  hr: Hr,
  table: Table,
  th: Th,
  td: Td,
  pre: Pre,
  code: Code,
  img: Img,
};

/** Inline output only: the paragraph wrapper is dropped, so a formula can sit in a line of text. */
const INLINE_COMPONENTS: Components = {
  p: ({ children }) => <>{children}</>,
};

/**
 * Renders one inline Markdown construct (`$x^2$`) with the same remark/rehype/KaTeX pipeline as
 * `MarkdownView`, as inline content. The editable Write view shows its inline math atoms with it,
 * so KaTeX is loaded once, through the one pipeline.
 */
export const InlineMarkdown = memo(function InlineMarkdown({ markdown }: { markdown: string }) {
  return (
    <Markdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={INLINE_REHYPE_PLUGINS}
      components={INLINE_COMPONENTS}
    >
      {markdown}
    </Markdown>
  );
});

interface MarkdownViewProps {
  /** Pandoc-style Markdown, as written by the CLI's Markdown-first path (`book_builder.py`). */
  markdown: string;
  /** Looked up by citekey (matched against `RagCitation.id`) to label/resolve `[@key]`/`\cite{key}` chips. */
  citations?: readonly RagCitation[];
  /** Called with a citekey when its chip is clicked; omit to render chips as inert labels. */
  onCitationClick?: (citeKey: string) => void;
  /** Comment/suggestion/review ranges to highlight, in UTF-16 offsets over `markdown` (issue #182). */
  anchorMarks?: readonly AnchorMark[];
  /** The highlight to draw as focused. Changing it (or `anchorMarks`) never re-renders the Markdown. */
  focusedAnchorId?: string | null;
  /** Tag rendered text with its Markdown offsets so a DOM selection can be mapped back (`sourceRangeFromSelection`). */
  sourceMap?: boolean;
  /** Fired with the anchor ids under a click on a highlight (innermost first). */
  onAnchorClick?: (ids: string[]) => void;
  className?: string;
}

const NO_MARKS: readonly AnchorMark[] = [];

/**
 * Renders CLI-generated section Markdown: GFM (tables, strikethrough, task
 * lists) + `$…$`/`$$…$$` math (KaTeX) + theorem/definition/lemma/proof/example
 * callouts + clickable citation chips, sanitized against a math-aware schema
 * (`mathAwareSchema`) so no raw HTML the LLM emits can inject a script or
 * event handler.
 *
 * Memoised, and the parsed element is memoised on the Markdown alone: highlight, focus and
 * citation changes re-render at most the chips and a layout effect, never the remark/rehype/KaTeX
 * pipeline or the DOM the reader has selected text in. Highlights are painted with the CSS
 * Custom Highlight API where it exists (`write-highlights.ts`), else wrapped in `<mark>`s by
 * rehype (which does re-run the pipeline when they change).
 */
export const MarkdownView = memo(function MarkdownView({
  markdown,
  citations,
  onCitationClick,
  anchorMarks = NO_MARKS,
  focusedAnchorId = null,
  sourceMap = false,
  onAnchorClick,
  className,
}: MarkdownViewProps) {
  const citationsById = useMemo(() => {
    const map = new Map<string, RagCitation>();
    for (const citation of citations ?? []) map.set(citation.id, citation);
    return map;
  }, [citations]);
  const context = useMemo(
    () => ({ citationsById, onCitationClick }),
    [citationsById, onCitationClick],
  );

  const custom = useMemo(() => supportsCustomHighlights(), []);
  const rootRef = useRef<HTMLDivElement>(null);
  const normalized = useMemo(() => normalizeDisplayMathMapped(markdown), [markdown]);
  const wrapMarks = custom ? NO_MARKS : anchorMarks;
  const rehypePlugins = useMemo<RehypePlugins>(
    () =>
      wrapMarks.length || sourceMap
        ? [
            rehypeMathPositions,
            ...BASE_REHYPE_PLUGINS,
            [rehypeAnchorSource, { normalized, marks: wrapMarks, sourceMap }],
          ]
        : BASE_REHYPE_PLUGINS,
    [normalized, wrapMarks, sourceMap],
  );
  const body = useMemo(
    () => (
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehypePlugins}
        components={MARKDOWN_COMPONENTS}
      >
        {normalized.text}
      </Markdown>
    ),
    [rehypePlugins, normalized],
  );

  // Custom Highlight API: paint the ranges (no DOM change).
  useEffect(() => {
    const root = rootRef.current;
    if (!custom || !root) return undefined;
    return applyWriteHighlights(root, markdown, anchorMarks, focusedAnchorId);
  }, [custom, markdown, anchorMarks, focusedAnchorId, body]);

  // Fallback: the marks are already in the DOM; focus is a class toggle.
  useEffect(() => {
    const root = rootRef.current;
    if (custom || !root) return;
    for (const mark of root.querySelectorAll('[data-anchor-ids]')) {
      const ids = mark.getAttribute('data-anchor-ids')?.split(' ') ?? [];
      mark.classList.toggle(
        'anchor-focused',
        focusedAnchorId !== null && ids.includes(focusedAnchorId),
      );
    }
  }, [custom, focusedAnchorId, anchorMarks, body]);

  function handleClick(event: React.MouseEvent<HTMLDivElement>) {
    const root = rootRef.current;
    if (!onAnchorClick || !root) return;
    let ids: string[] = [];
    if (custom) {
      // Highlights are not elements: hit-test the painted rectangles under the pointer, but leave a
      // drag-selection's click alone.
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed) {
        ids = highlightIdsAtPoint(root, event.clientX, event.clientY, event.target);
      }
    } else if (event.target instanceof Element) {
      const hit = event.target.closest('[data-anchor-ids]');
      ids = hit?.getAttribute('data-anchor-ids')?.split(' ').filter(Boolean) ?? [];
    }
    if (ids.length) onAnchorClick(ids);
  }

  return (
    <MarkdownContext.Provider value={context}>
      {/* The click handler only maps a click on a highlight to its margin card (which is itself
          keyboard reachable); the wrapper is not interactive. */}
      <div
        ref={rootRef}
        data-markdown-root=""
        className={cn('text-sm text-foreground', className)}
        onClick={handleClick}
      >
        {body}
      </div>
    </MarkdownContext.Provider>
  );
});
