import {
  Schema,
  type DOMOutputSpec,
  type MarkSpec,
  type Node as PMNode,
  type NodeSpec,
} from 'prosemirror-model';

/**
 * The editable Write view's document model (issue #182, phase 5). It is a *view* of the Markdown
 * source, never its owner: every node that cannot be edited faithfully is an atom that carries its
 * exact source (`atom_block` / `atom_inline`), and `source-model.ts` keeps the source string, so
 * untouched Markdown stays byte-identical.
 *
 * Class names mirror the read-only renderer's component overrides (`markdown-view.tsx`) so the
 * switch from the read-only first paint to the editor does not move the text.
 */
const P_CLASS = 'my-2.5 leading-relaxed';
const HEADING_CLASS: Record<number, string> = {
  1: 'mt-6 mb-3 font-serif text-2xl font-bold tracking-tight',
  2: 'mt-5 mb-2 font-serif text-xl font-semibold tracking-tight',
  3: 'mt-4 mb-2 font-serif text-lg font-medium',
  4: 'mt-4 mb-2 font-serif text-base font-medium',
  5: 'mt-3 mb-1.5 font-serif text-sm font-semibold',
  6: 'mt-3 mb-1.5 font-serif text-sm font-medium italic',
};
export const LINK_CLASS = 'text-primary underline underline-offset-2';
export const CODE_CLASS = 'rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]';

export type AtomBlockKind =
  'math' | 'table' | 'callout' | 'html' | 'footnote' | 'definition' | 'rule' | 'raw';
export type AtomInlineKind =
  'math' | 'citation' | 'html' | 'footnote' | 'image' | 'link' | 'reference' | 'strike' | 'raw';

const nodes: Record<string, NodeSpec> = {
  doc: { content: '(block | top_block)+' },
  paragraph: {
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p' }],
    toDOM: (): DOMOutputSpec => ['p', { class: P_CLASS }, 0],
  },
  heading: {
    attrs: { level: { default: 1 }, setext: { default: false } },
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
    toDOM: (node): DOMOutputSpec => [
      `h${node.attrs['level'] as number}`,
      { class: HEADING_CLASS[node.attrs['level'] as number] ?? HEADING_CLASS[3]! },
      0,
    ],
  },
  code_block: {
    attrs: { info: { default: '' }, fence: { default: '`' } },
    content: 'text*',
    marks: '',
    group: 'block',
    code: true,
    defining: true,
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    toDOM: (): DOMOutputSpec => [
      'pre',
      {
        class:
          'custom-scrollbar my-3 overflow-x-auto rounded-lg border bg-muted p-3 font-mono text-xs leading-relaxed',
      },
      ['code', { class: 'font-mono text-xs' }, 0],
    ],
  },
  blockquote: {
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: (): DOMOutputSpec => [
      'blockquote',
      {
        class:
          'my-3 border-l-2 border-muted-foreground/30 pl-4 text-sm text-muted-foreground italic',
      },
      0,
    ],
  },
  bullet_list: {
    attrs: { marker: { default: '-' }, tight: { default: true } },
    content: 'list_item+',
    group: 'block',
    parseDOM: [{ tag: 'ul' }],
    toDOM: (node): DOMOutputSpec => [
      'ul',
      { class: 'my-2 ml-5 list-disc space-y-1', 'data-tight': String(node.attrs['tight']) },
      0,
    ],
  },
  ordered_list: {
    attrs: {
      start: { default: 1 },
      delim: { default: '.' },
      step: { default: 1 },
      tight: { default: true },
    },
    content: 'list_item+',
    group: 'block',
    parseDOM: [
      {
        tag: 'ol',
        getAttrs: (dom) => ({ start: Number((dom as HTMLElement).getAttribute('start')) || 1 }),
      },
    ],
    toDOM: (node): DOMOutputSpec => [
      'ol',
      {
        class: 'my-2 ml-5 list-decimal space-y-1',
        'data-tight': String(node.attrs['tight']),
        ...(node.attrs['start'] === 1 ? {} : { start: String(node.attrs['start']) }),
      },
      0,
    ],
  },
  list_item: {
    content: 'block+',
    defining: true,
    parseDOM: [{ tag: 'li' }],
    toDOM: (): DOMOutputSpec => ['li', 0],
  },
  /** A block this editor cannot represent faithfully: it keeps its exact source and is edited in Source. */
  atom_block: {
    attrs: { source: { default: '' }, kind: { default: 'raw' }, label: { default: '' } },
    // (Top level only: its source cannot carry the prefix of a list item or a quote.)
    group: 'top_block',
    atom: true,
    selectable: true,
    draggable: false,
    parseDOM: [
      {
        tag: 'div[data-md-atom-block]',
        getAttrs: (dom) => {
          const el = dom as HTMLElement;
          return {
            source: el.getAttribute('data-md-source') ?? '',
            kind: el.getAttribute('data-md-kind') ?? 'raw',
            label: el.getAttribute('data-md-label') ?? '',
          };
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => [
      'div',
      {
        'data-md-atom-block': '',
        'data-md-source': node.attrs['source'] as string,
        'data-md-kind': node.attrs['kind'] as string,
        'data-md-label': node.attrs['label'] as string,
      },
      node.attrs['source'] as string,
    ],
  },
  text: { group: 'inline' },
  hard_break: {
    inline: true,
    group: 'inline',
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: (): DOMOutputSpec => ['br'],
  },
  /** A line break inside a paragraph (a newline in the source): shown as a space, like the rendered view. */
  soft_break: {
    inline: true,
    group: 'inline',
    selectable: false,
    toDOM: (): DOMOutputSpec => ['span', { class: 'md-soft-break', 'data-md-soft': '' }, ' '],
  },
  atom_inline: {
    attrs: { source: { default: '' }, kind: { default: 'raw' }, label: { default: '' } },
    // (Not code: an atom is source that is read, a code span is source that is not.)
    marks: 'link strong em strike',
    inline: true,
    group: 'inline',
    atom: true,
    selectable: true,
    draggable: false,
    parseDOM: [
      {
        tag: 'span[data-md-atom-inline]',
        getAttrs: (dom) => {
          const el = dom as HTMLElement;
          return {
            source: el.getAttribute('data-md-source') ?? '',
            kind: el.getAttribute('data-md-kind') ?? 'raw',
            label: el.getAttribute('data-md-label') ?? '',
          };
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => [
      'span',
      {
        'data-md-atom-inline': '',
        'data-md-source': node.attrs['source'] as string,
        'data-md-kind': node.attrs['kind'] as string,
        'data-md-label': node.attrs['label'] as string,
      },
      node.attrs['source'] as string,
    ],
  },
};

/** Order matters: it is the nesting order when a run carries several marks (link outermost, code innermost). */
const marks: Record<string, MarkSpec> = {
  link: {
    attrs: { href: {}, title: { default: '' } },
    inclusive: false,
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs: (dom) => {
          const el = dom as HTMLElement;
          const href = el.getAttribute('href') ?? '';
          // Only links that mean something in Markdown; never a script URL.
          if (/^\s*(javascript|data|vbscript):/i.test(href)) return false;
          return { href, title: el.getAttribute('title') ?? '' };
        },
      },
    ],
    toDOM: (mark): DOMOutputSpec => [
      'a',
      {
        href: mark.attrs['href'] as string,
        ...(mark.attrs['title'] ? { title: mark.attrs['title'] as string } : {}),
        class: LINK_CLASS,
        rel: 'noreferrer noopener',
      },
      0,
    ],
  },
  strong: {
    parseDOM: [
      { tag: 'strong' },
      { tag: 'b', getAttrs: (dom) => (dom as HTMLElement).style.fontWeight !== 'normal' && null },
      {
        style: 'font-weight=400',
        clearMark: (mark) => mark.type.name === 'strong',
      },
      {
        style: 'font-weight',
        getAttrs: (value) => /^(bold(er)?|[5-9]\d{2,})$/.test(value as string) && null,
      },
    ],
    toDOM: (): DOMOutputSpec => ['strong', 0],
  },
  em: {
    parseDOM: [
      { tag: 'em' },
      { tag: 'i', getAttrs: (dom) => (dom as HTMLElement).style.fontStyle !== 'normal' && null },
      { style: 'font-style=italic' },
    ],
    toDOM: (): DOMOutputSpec => ['em', 0],
  },
  strike: {
    parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }],
    toDOM: (): DOMOutputSpec => ['s', 0],
  },
  code: {
    parseDOM: [{ tag: 'code' }],
    toDOM: (): DOMOutputSpec => ['code', { class: CODE_CLASS }, 0],
  },
};

export const schema = new Schema({ nodes, marks });

export const MARK_ORDER = ['link', 'strong', 'em', 'strike', 'code'] as const;

export function isTextblock(node: PMNode): boolean {
  return node.isTextblock;
}
