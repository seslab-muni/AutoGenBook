const STANDALONE_DISPLAY_MATH = /^\s*\$\$([^$\n]+)\$\$\s*$/;

/**
 * `remark-math` only parses `$$...$$` as *block* (display) math when the
 * fences sit on their own lines (like a fenced code block); a single line
 * `$$expr$$` parses as plain *inline* math instead, so it wouldn't get
 * KaTeX's centered/larger display rendering. The CLI's Markdown-first output
 * (and content authored by hand in `SectionEditor`) commonly writes display
 * equations as one line (`_reference` sample data mirrors real section
 * output this way), so this promotes any line whose entire trimmed content
 * is a single `$$...$$` span onto the three-line form `remark-math` requires
 * — run once, before the Markdown is parsed.
 */
export function normalizeDisplayMath(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => {
      const match = STANDALONE_DISPLAY_MATH.exec(line);
      return match ? `$$\n${match[1]!.trim()}\n$$` : line;
    })
    .join('\n');
}
