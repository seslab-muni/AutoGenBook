import type { Element, ElementContent, Root, Text } from 'hast';
import { SKIP, visit } from 'unist-util-visit';

import type { NormalizedMarkdown } from './normalize-display-math';
import { alignValueToSource } from './source-map';

/** A range to highlight, in UTF-16 offsets over the author's Markdown. */
export interface AnchorMark {
  id: string;
  kind: string;
  start: number;
  end: number;
}

export interface AnchorSourceOptions {
  /** What the parser was given and how its offsets map back to the author's text. */
  normalized: NormalizedMarkdown;
  marks: readonly AnchorMark[];
  /**
   * Annotate every positioned text node with `data-src-start`/`data-src-end` (author offsets), the
   * map {@link sourceRangeFromSelection} reads back. Needed for selections to work; off, only the
   * highlighted ranges are touched.
   */
  sourceMap?: boolean;
}

interface Placed extends AnchorMark {
  nStart: number;
  nEnd: number;
}

function classNames(element: Element): string[] {
  const value = element.properties?.className;
  if (Array.isArray(value)) return value.map(String);
  return typeof value === 'string' ? (value as string).split(/\s+/) : [];
}

/** Elements whose children are rendered output with no source positions of their own (KaTeX, citation chips). */
function isOpaque(element: Element): boolean {
  if (element.properties && 'citekey' in element.properties) return true;
  return classNames(element).includes('anchor-math');
}

function isMathNode(element: Element): boolean {
  if (element.tagName === 'span' || element.tagName === 'code') {
    return classNames(element).includes('math-inline');
  }
  if (element.tagName !== 'pre') return false;
  const code = element.children.find((child): child is Element => child.type === 'element');
  return code?.tagName === 'code' && classNames(code).includes('language-math');
}

/**
 * Rehype plugin, run before KaTeX: KaTeX replaces a math node with output that has no source
 * positions, so the node is first wrapped in a `span.anchor-math` that keeps its position.
 */
export function rehypeMathPositions() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element, index, parent) => {
      if (!parent || index === undefined || !node.position || !isMathNode(node)) return undefined;
      parent.children.splice(index, 1, {
        type: 'element',
        tagName: 'span',
        properties: { className: ['anchor-math'] },
        position: node.position,
        children: [node],
      });
      return [SKIP, index + 1];
    });
  };
}

function annotate(
  properties: NonNullable<Element['properties']>,
  start: number,
  end: number,
  covering: readonly Placed[],
): void {
  properties['dataSrcStart'] = start;
  properties['dataSrcEnd'] = end;
  if (covering.length > 0) {
    properties['dataAnchorIds'] = covering.map((mark) => mark.id).join(' ');
    properties['dataAnchorKind'] = covering[0]!.kind;
  }
}

/**
 * Rehype plugin (run after sanitising): wraps the text covered by each mark in a `<mark>` carrying
 * `data-anchor-ids`, splitting text nodes at range edges, and (with `sourceMap`) tags every
 * positioned text node and opaque element with the author offsets it came from. A range can span
 * elements, inline math and citations: each text node is wrapped on its own, and an opaque
 * element that a range touches is tagged as a whole instead of being split.
 */
export function rehypeAnchorSource(options: AnchorSourceOptions) {
  const { normalized, sourceMap = false } = options;
  const placed: Placed[] = options.marks
    .filter((mark) => mark.end > mark.start)
    .map((mark) => ({
      ...mark,
      nStart: normalized.toNormalized(mark.start, 'start'),
      nEnd: normalized.toNormalized(mark.end, 'end'),
    }));
  const source = normalized.text;

  return (tree: Root) => {
    if (placed.length === 0 && !sourceMap) return;

    const overlapping = (start: number, end: number): Placed[] =>
      placed.filter((mark) => mark.nStart < end && mark.nEnd > start);

    visit(tree, (node, index, parent) => {
      if (node.type === 'element') {
        const element = node as Element;
        const position = element.position;
        if (isOpaque(element)) {
          if (position?.start.offset != null && position.end.offset != null) {
            const s = position.start.offset;
            const e = position.end.offset;
            const covering = overlapping(s, e);
            if (covering.length > 0 || sourceMap) {
              element.properties ??= {};
              annotate(
                element.properties,
                normalized.toOriginal(s, 'start'),
                normalized.toOriginal(e, 'end'),
                covering,
              );
              if (covering.length > 0) {
                element.properties['className'] = [
                  ...classNames(element),
                  'anchor-mark',
                  `anchor-${covering[0]!.kind}`,
                ];
              }
            }
          }
          return SKIP;
        }
        return undefined;
      }
      if (node.type !== 'text' || !parent || index === undefined) return undefined;
      const text = node as Text;
      const s = text.position?.start.offset;
      const e = text.position?.end.offset;
      if (s == null || e == null || text.value.length === 0) return undefined;
      const hits = overlapping(s, e);
      if (hits.length === 0 && !sourceMap) return undefined;

      const value = text.value;
      const map = alignValueToSource(value, source.slice(s, e));
      // Source offset (normalized) of value[i]; without a map the node is one unit.
      const at = (i: number) => (map ? s + map[i]! : s);
      const after = (i: number) => (map ? s + map[i - 1]! + 1 : e);

      const cuts = new Set<number>([0, value.length]);
      for (const mark of hits) {
        if (map) {
          let lo = 0;
          while (lo < value.length && s + map[lo]! < mark.nStart) lo += 1;
          let hi = value.length;
          while (hi > lo && s + map[hi - 1]! >= mark.nEnd) hi -= 1;
          cuts.add(lo);
          cuts.add(hi);
        }
      }
      const sorted = [...cuts].sort((a, b) => a - b);
      const pieces: ElementContent[] = [];
      for (let k = 0; k + 1 < sorted.length; k += 1) {
        const a = sorted[k]!;
        const b = sorted[k + 1]!;
        if (b <= a) continue;
        const sStart = at(a);
        const sEnd = after(b);
        const covering = hits.filter((mark) =>
          map ? mark.nStart <= at(a) && mark.nEnd >= after(b) : true,
        );
        const properties: NonNullable<Element['properties']> = {};
        annotate(
          properties,
          normalized.toOriginal(sStart, 'start'),
          normalized.toOriginal(sEnd, 'end'),
          covering,
        );
        if (covering.length > 0) {
          properties['className'] = ['anchor-mark', `anchor-${covering[0]!.kind}`];
        }
        pieces.push({
          type: 'element',
          tagName: covering.length > 0 ? 'mark' : 'span',
          properties,
          children: [{ type: 'text', value: value.slice(a, b) }],
        });
      }
      if (pieces.length === 0) return undefined;
      parent.children.splice(index, 1, ...pieces);
      return [SKIP, index + pieces.length];
    });
  };
}
