import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import type { Root } from 'mdast';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

import { normalizeDisplayMath } from '@/features/editor/lib/normalize-display-math';

const processor = unified().use(remarkParse).use(remarkMath);

/**
 * Counts display-math blocks (`$$...$$`) in `markdown` by parsing it into an
 * mdast tree and counting `math` nodes — not by regex-matching `$$`, which
 * would also match inline math sequences or `$$` inside code fences.
 * `normalizeDisplayMath` runs first so a single-line `$$expr$$` (also
 * promoted to display math by `MarkdownView`) counts too.
 */
export function countDisplayEquations(markdown: string): number {
  const tree = processor.parse(normalizeDisplayMath(markdown)) as Root;
  let count = 0;
  visit(tree, 'math', () => {
    count += 1;
  });
  return count;
}
