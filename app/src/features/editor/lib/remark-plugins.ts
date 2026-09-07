import { toString as mdastToString } from 'mdast-util-to-string';
import type { Blockquote, PhrasingContent, Root, Text } from 'mdast';
import { visit } from 'unist-util-visit';

/**
 * Remark plugin: turns pandoc-style `[@key]` / `[@key1; @key2]` citation
 * markers and legacy `\cite{key}` / `\cite{key1,key2}` tokens (the format the
 * CLI actually writes into Markdown-first section files — see
 * `prompts/book/book_section_writer_user_md.md`) into a `span` carrying a
 * plain `citekey` attribute per key, rendered as a `<CitationChip>` by
 * `MarkdownView`'s `span` component override (a real `citekey`-less `span`
 * stays a plain `<span>` — this reuses the tag rather than inventing one so
 * `react-markdown`'s `Components` type, keyed by `JSX.IntrinsicElements`,
 * stays satisfied). Runs on plain `text` nodes only, so it never touches
 * math nodes (`remark-math` has already split those into `math`/`inlineMath`
 * node types by the time this plugin sees the tree).
 */
const CITE_PATTERN = /\[@([^\]]+)\]|\\cite\{([^}]+)\}/g;

function splitKeys(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((part) => part.replace(/^@/, '').trim())
    .filter(Boolean);
}

export function remarkCitations() {
  return (tree: Root) => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || index === undefined) return;
      const value = node.value;
      CITE_PATTERN.lastIndex = 0;
      if (!CITE_PATTERN.test(value)) return;
      CITE_PATTERN.lastIndex = 0;

      const replacement: PhrasingContent[] = [];
      let lastEnd = 0;
      let match: RegExpExecArray | null;
      while ((match = CITE_PATTERN.exec(value)) !== null) {
        if (match.index > lastEnd) {
          replacement.push({ type: 'text', value: value.slice(lastEnd, match.index) });
        }
        const keys = splitKeys(match[1] ?? match[2] ?? '');
        for (const key of keys) {
          replacement.push({
            type: 'text',
            value: `@${key}`,
            data: {
              hName: 'span',
              hProperties: { citekey: key },
            },
          } as unknown as PhrasingContent);
        }
        lastEnd = match.index + match[0].length;
      }
      if (lastEnd < value.length) {
        replacement.push({ type: 'text', value: value.slice(lastEnd) });
      }

      const siblings = parent.children as PhrasingContent[];
      siblings.splice(index, 1, ...replacement);
      return index + replacement.length;
    });
  };
}

const CALLOUT_KEYWORDS = ['Theorem', 'Lemma', 'Definition', 'Proof', 'Example'] as const;
export type CalloutKind = (typeof CALLOUT_KEYWORDS)[number];

const CALLOUT_PATTERN = new RegExp(`^(${CALLOUT_KEYWORDS.join('|')})\\b`);

/**
 * Remark plugin: a blockquote whose first paragraph starts with
 * `**Theorem**`/`**Lemma**`/`**Definition**`/`**Proof**`/`**Example**`
 * (optionally followed by punctuation, e.g. `**Theorem 1.1**:`) gets
 * `calloutkind`/`calloutlabel` attributes attached to its (still plain
 * `<blockquote>`) hast node, so `MarkdownView`'s `blockquote` component
 * override can render it as a `<Callout>` card instead — no new tag name,
 * for the same `Components`-typing reason as `remarkCitations`.
 */
export function remarkCallouts() {
  return (tree: Root) => {
    visit(tree, 'blockquote', (node: Blockquote) => {
      const firstParagraph = node.children[0];
      if (!firstParagraph || firstParagraph.type !== 'paragraph') return;
      const firstChild = firstParagraph.children[0];
      if (!firstChild || firstChild.type !== 'strong') return;

      const label = mdastToString(firstChild).trim();
      const kindMatch = CALLOUT_PATTERN.exec(label);
      if (!kindMatch) return;

      // Drop the leading `**Theorem 1.1**` (and any immediately-following
      // punctuation like `:`/`—`) from the visible body — it's shown as the
      // card's header instead (see `Callout`).
      const rest = firstParagraph.children.slice(1);
      const next = rest[0];
      if (next?.type === 'text') {
        next.value = next.value.replace(/^[\s:.–—-]+/, '');
      }
      firstParagraph.children = rest;

      (node as Blockquote & { data?: Record<string, unknown> }).data = {
        hProperties: { calloutkind: kindMatch[1], calloutlabel: label },
      };
    });
  };
}
