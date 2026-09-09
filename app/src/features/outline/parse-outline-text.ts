/**
 * Turns pasted text into a nested outline draft. Three input styles are
 * recognized per line, independently, so mixed pastes still work:
 *  - Markdown ATX headings ("#", "##", ...) nest by heading level.
 *  - Dotted/parenthesized numbering ("1.", "1.1", "2.3.1)") nests by how
 *    many numeric segments precede the title.
 *  - Anything else is treated as a flat, top-level chapter title.
 * Never throws — malformed or empty input just yields fewer/no nodes.
 */

export interface ParsedOutlineNode {
  title: string;
  children: ParsedOutlineNode[];
}

const MARKDOWN_HEADING = /^\s*(#{1,6})\s+(.+)$/;
const NUMBERED_HEADING = /^\s*(\d+(?:\.\d+)*)[.)]?\s+(.+)$/;
const HAS_TRAILING_PUNCTUATION = /^\s*\d+(?:\.\d+)*[.)]/;
const BULLET_MARKER = /^[-*•+]\s+/;

interface LineEntry {
  depth: number;
  title: string;
}

function matchMarkdownHeading(line: string): LineEntry | null {
  const match = MARKDOWN_HEADING.exec(line);
  if (!match) return null;
  const title = match[2]!.trim().replace(/\s+#+$/, '').trim();
  if (title.length === 0) return null;
  return { depth: match[1]!.length - 1, title };
}

function matchNumberedHeading(line: string): LineEntry | null {
  const match = NUMBERED_HEADING.exec(line);
  if (!match) return null;
  const segments = match[1]!.split('.');
  if (segments.length === 1 && !HAS_TRAILING_PUNCTUATION.test(line)) return null;
  const title = match[2]!.trim();
  if (title.length === 0) return null;
  return { depth: segments.length - 1, title };
}

function classifyLine(line: string): LineEntry | null {
  const markdown = matchMarkdownHeading(line);
  if (markdown) return markdown;
  const numbered = matchNumberedHeading(line);
  if (numbered) return numbered;
  const title = line.trim().replace(BULLET_MARKER, '').trim();
  if (title.length === 0) return null;
  return { depth: 0, title };
}

/** Parses `text` into a nested outline tree, clamped to `maxDepth` levels (1-based). */
export function parseOutlineText(text: string, maxDepth: number): ParsedOutlineNode[] {
  if (typeof text !== 'string' || text.trim().length === 0) return [];
  const depthLimit = Math.max(Math.floor(maxDepth) - 1, 0);

  const roots: ParsedOutlineNode[] = [];
  const stack: { depth: number; node: ParsedOutlineNode }[] = [];

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    if (rawLine.trim().length === 0) continue;
    const entry = classifyLine(rawLine);
    if (!entry) continue;

    const depth = Math.min(Math.max(entry.depth, 0), depthLimit);
    const node: ParsedOutlineNode = { title: entry.title, children: [] };

    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.node.children.push(node);
    else roots.push(node);
    stack.push({ depth, node });
  }

  return roots;
}
