import { Fragment, Slice, type Node as PMNode, type ResolvedPos } from 'prosemirror-model';

import { parseDocument } from './parse';
import { DEFAULT_STYLE, serializeBlock } from './serialize';
import { schema } from './schema';

/**
 * Copy and paste for the editable Write view (issue #182, phase 5). Pasted plain text is read as
 * Markdown with the same parser the view itself uses, so pasting Markdown source gives formatted
 * text (and atoms for math, citations and the like); rich HTML goes through the schema's `parseDOM`
 * rules, which keep text, paragraphs, headings, lists, quotes, code and the basic marks and nothing
 * else (no raw HTML ever reaches the document). Copying puts Markdown on the clipboard as text.
 */

const para = schema.nodes['paragraph']!;

/** Plain text pasted into code: the characters, as they are. */
function codeSlice(text: string): Slice {
  return new Slice(text ? Fragment.from(schema.text(text)) : Fragment.empty, 0, 0);
}

/** `text` read as Markdown, as a slice that merges into the surrounding text where it can. */
export function markdownSlice(text: string): Slice {
  const parsed = parseDocument(text.replace(/\r\n?/g, '\n'), { trailingParagraph: false });
  const blocks = parsed.segments.map((segment) => segment.node);
  if (blocks.length === 0) return Slice.empty;
  const first = blocks[0]!;
  if (blocks.length === 1 && first.type === para) {
    return new Slice(first.content, 0, 0);
  }
  const openStart = first.isTextblock ? 1 : 0;
  const last = blocks[blocks.length - 1]!;
  const openEnd = last.isTextblock ? 1 : 0;
  return new Slice(Fragment.fromArray(blocks), openStart, openEnd);
}

/** Pasting plain text: Markdown unless the caret is in a code block (or Shift was held). */
export function parseClipboardText(text: string, $context: ResolvedPos, plain: boolean): Slice {
  if ($context.parent.type.spec.code) return codeSlice(text);
  if (plain) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const nodes: PMNode[] = [];
    for (const line of lines) {
      nodes.push(para.create(null, line ? [schema.text(line)] : []));
    }
    return nodes.length === 1
      ? new Slice(nodes[0]!.content, 0, 0)
      : new Slice(Fragment.fromArray(nodes), 1, 1);
  }
  return markdownSlice(text);
}

const DROP =
  'script, style, head, meta, link, title, iframe, object, embed, noscript, template, svg, math, form, input, button, select, textarea';

/** Removes what must never be read as content from pasted HTML before the schema rules see it. */
export function cleanPastedHtml(html: string): string {
  if (typeof document === 'undefined') return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const el of template.content.querySelectorAll(DROP)) el.remove();
  return template.innerHTML;
}

/** Markdown text for a copied slice. */
export function sliceToMarkdown(slice: Slice): string {
  try {
    const blocks: PMNode[] = [];
    slice.content.forEach((node) => blocks.push(node));
    const inlineOnly = blocks.length > 0 && blocks.every((node) => node.isInline);
    const nodes = inlineOnly ? [para.create(null, slice.content)] : blocks;
    return nodes.map((node) => serializeBlock(node, DEFAULT_STYLE, 1).src).join('\n\n');
  } catch {
    return slice.content.textBetween(0, slice.content.size, '\n\n');
  }
}
