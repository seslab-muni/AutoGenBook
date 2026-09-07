import { defaultSchema, type Schema } from 'hast-util-sanitize';

/**
 * `rehype-sanitize`'s default (GitHub-flavored) schema already covers GFM
 * tables/code/links/headings; it's extended here for the two things
 * `MarkdownView` renders that GitHub Markdown never does:
 *
 * - `rehype-katex`'s output — `<span>` elements carrying many `katex-*`
 *   classes and inline `style` (KaTeX positions glyphs with absolute
 *   spans), an accessible `<math>`/MathML subtree, and inline `<svg>`/`<path>`
 *   for stretchy glyphs (surds, braces, arrows). None of `className`/`style`
 *   on `span`, or MathML/SVG tags at all, are in the default schema.
 * - `remarkCitations`/`remarkCallouts` (`remark-plugins.ts`), which attach a
 *   plain `citekey` attribute to a `span` and `calloutkind`/`calloutlabel`
 *   attributes to a `blockquote` rather than inventing new tag names — kept
 *   as ordinary tags so `MarkdownView`'s `components` map stays within
 *   `react-markdown`'s `JSX.IntrinsicElements`-keyed `Components` type.
 *
 * `<script>`/`<style>`/event-handler attributes are never added back —
 * they're absent from `defaultSchema` and this only ever adds to its
 * `tagNames`/`attributes`, never removes from `strip`. Verified by the
 * sanitizer test in `markdown-view.test.tsx`.
 */
export const mathAwareSchema: Schema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    // MathML (accessible/copy-pasteable source KaTeX embeds alongside the HTML rendering).
    'math',
    'semantics',
    'mrow',
    'mi',
    'mo',
    'mn',
    'mtext',
    'mspace',
    'msup',
    'msub',
    'msubsup',
    'mfrac',
    'msqrt',
    'mroot',
    'mtable',
    'mtr',
    'mtd',
    'mover',
    'munder',
    'munderover',
    'mpadded',
    'mphantom',
    'mstyle',
    'menclose',
    'annotation',
    // Inline SVG (KaTeX's stretchy surds/braces/arrows).
    'svg',
    'path',
    'line',
    'g',
  ],
  attributes: {
    ...defaultSchema.attributes,
    span: ['className', 'style', 'ariaHidden', 'citekey'],
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), 'calloutkind', 'calloutlabel'],
    math: ['xmlns', 'display'],
    annotation: ['encoding'],
    svg: ['xmlns', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'style', 'className'],
    path: ['d', 'style', 'className'],
    line: ['x1', 'y1', 'x2', 'y2', 'style', 'className'],
  },
};
