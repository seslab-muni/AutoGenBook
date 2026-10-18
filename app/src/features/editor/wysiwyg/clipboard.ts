import { Fragment, Slice, type Node as PMNode, type ResolvedPos } from 'prosemirror-model';
import { NodeSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

import { parseDocument } from './parse';
import { DEFAULT_STYLE, serializeBlock, LEVELS } from './serialize';
import { CLIPBOARD_SESSION, schema } from './schema';

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
  const source = text.replace(/\r\n?/g, '\n');
  const parsed = parseDocument(source, { trailingParagraph: false });
  const blocks = parsed.segments.map((segment) => segment.node);
  if (blocks.length === 0) {
    // Only whitespace: spaces are text, blank lines are nothing.
    const spaces = source.replace(/\s*\n\s*/g, ' ');
    return spaces ? new Slice(Fragment.from(schema.text(spaces)), 0, 0) : Slice.empty;
  }
  const first = blocks[0]!;
  if (blocks.length === 1 && first.type === para) {
    // Markdown drops the edge whitespace of a paragraph; a pasted fragment ` and more` keeps its space.
    const lead = /^[ \t]+/.exec(source)?.[0] ?? '';
    const trail = /[ \t]+$/.exec(source)?.[0] ?? '';
    const parts: PMNode[] = [];
    if (lead) parts.push(schema.text(lead));
    first.content.forEach((child) => parts.push(child));
    if (trail) parts.push(schema.text(trail));
    return new Slice(Fragment.fromArray(parts), 0, 0);
  }
  const last = blocks[blocks.length - 1]!;
  // Blocks that begin or end with a blank line are meant as blocks of their own; otherwise the first
  // and last join the text around the caret, as pasted paragraphs do.
  const separateStart = /^[ \t]*\n/.test(source);
  const separateEnd = /\n[ \t]*$/.test(source);
  const openStart = first.isTextblock && !separateStart ? 1 : 0;
  const openEnd = last.isTextblock && !separateEnd ? 1 : 0;
  return new Slice(Fragment.fromArray(blocks), openStart, openEnd);
}

/**
 * A block atom (a table, display math, HTML...) keeps its source verbatim, which has no way to carry
 * the prefix of a list item or a quote: pasted inside one it becomes the text of its source.
 */
export function containerSafe(slice: Slice, $from: ResolvedPos): Slice {
  let inside = false;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name;
    if (name === 'list_item' || name === 'blockquote') inside = true;
  }
  if (!inside) return slice;
  let found = false;
  slice.content.descendants((node) => {
    if (node.type.name === 'atom_block') found = true;
    return !found;
  });
  if (!found) return slice;
  const convert = (node: PMNode): PMNode => {
    if (node.type.name === 'atom_block') {
      const parts: PMNode[] = [];
      (node.attrs['source'] as string).split('\n').forEach((line, index) => {
        if (index > 0) parts.push(schema.nodes['soft_break']!.create());
        if (line) parts.push(schema.text(line));
      });
      return para.create(null, parts);
    }
    if (node.isLeaf || node.isInline) return node;
    const children: PMNode[] = [];
    node.forEach((child) => children.push(convert(child)));
    return node.copy(Fragment.fromArray(children));
  };
  const blocks: PMNode[] = [];
  slice.content.forEach((node) => blocks.push(convert(node)));
  return new Slice(Fragment.fromArray(blocks), slice.openStart, slice.openEnd);
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

/**
 * Whether an atom element in pasted HTML is one this editor wrote: it carries this page's token,
 * and its source reads back as exactly one atom of the kind it claims (so a forged `data-md-source`
 * cannot smuggle Markdown or HTML the person never saw).
 */
function ownAtom(el: Element): boolean {
  if (el.getAttribute('data-md-session') !== CLIPBOARD_SESSION) return false;
  const source = el.getAttribute('data-md-source') ?? '';
  const kind = el.getAttribute('data-md-kind');
  try {
    if (el.hasAttribute('data-md-atom-block')) {
      const parsed = parseDocument(source, { trailingParagraph: false }).segments;
      const node = parsed.length === 1 ? parsed[0]!.node : null;
      return (
        node?.type.name === 'atom_block' &&
        node.attrs['kind'] === kind &&
        (node.attrs['source'] as string).trim() === source.trim()
      );
    }
    const parsed = parseDocument(source, { trailingParagraph: false }).segments;
    const para = parsed.length === 1 ? parsed[0]!.node : null;
    if (para?.type.name !== 'paragraph' || para.childCount !== 1) return false;
    const atom = para.firstChild!;
    return (
      atom.type.name === 'atom_inline' &&
      atom.attrs['kind'] === kind &&
      atom.attrs['source'] === source
    );
  } catch {
    return false;
  }
}

/** Removes what must never be read as content from pasted HTML before the schema rules see it. */
export function cleanPastedHtml(html: string): string {
  if (typeof document === 'undefined') return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const el of template.content.querySelectorAll(DROP)) el.remove();
  // The `data-md-*` attributes turn an element into an atom with the source in the attribute: only
  // for atoms this editor copied itself. From anywhere else they are stripped, and the element is
  // just text.
  for (const el of template.content.querySelectorAll('*')) {
    const atom = el.hasAttribute('data-md-atom-block') || el.hasAttribute('data-md-atom-inline');
    const own = atom && ownAtom(el);
    if (own) continue;
    for (const name of el.getAttributeNames()) {
      if (name.startsWith('data-md-')) el.removeAttribute(name);
    }
  }
  return template.innerHTML;
}

/** Markdown text for a copied slice. */
export function sliceToMarkdown(slice: Slice): string {
  try {
    const blocks: PMNode[] = [];
    slice.content.forEach((node) => blocks.push(node));
    const inlineOnly = blocks.length > 0 && blocks.every((node) => node.isInline);
    const nodes = inlineOnly ? [para.create(null, slice.content)] : blocks;
    return nodes.map((node) => serializeBlock(node, DEFAULT_STYLE, LEVELS[2]!).src).join('\n\n');
  } catch {
    return slice.content.textBetween(0, slice.content.size, '\n\n');
  }
}

/**
 * Pasting whole blocks (a heading, a list, paragraphs that began on a new line) puts them *between*
 * the text around the caret instead of folding the first block into the paragraph the caret is in,
 * which is what ProseMirror's fitting does with a closed slice. Returns whether it handled the paste.
 */
export function pasteBlocks(view: EditorView, pasted: Slice): boolean {
  const slice = containerSafe(pasted, view.state.selection.$from);
  const first = slice.content.firstChild;
  if (slice.openStart > 0 || !first || first.isInline) return false;
  const { state } = view;
  if (state.selection instanceof NodeSelection) return false;
  try {
    const tr = state.tr;
    if (!tr.selection.empty) tr.deleteSelection();
    const { $from } = tr.selection;
    const parent = $from.parent;
    if (!parent.isTextblock || parent.type.spec.code || $from.depth < 1) return false;
    const depth = $from.depth;
    if (parent.content.size === 0) {
      tr.replaceWith($from.before(depth), $from.after(depth), slice.content);
    } else if ($from.parentOffset === parent.content.size) {
      tr.insert($from.after(depth), slice.content);
    } else if ($from.parentOffset === 0) {
      tr.insert($from.before(depth), slice.content);
    } else {
      const pos = $from.pos;
      // Split the paragraph at the caret; the pasted blocks go between the halves.
      tr.split(pos);
      tr.insert(pos + 1, slice.content);
    }
    view.dispatch(tr.scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'));
    return true;
  } catch {
    return false;
  }
}
