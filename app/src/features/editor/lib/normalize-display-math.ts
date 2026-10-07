const STANDALONE_DISPLAY_MATH = /^\s*\$\$([^$\n]+)\$\$\s*$/;

/**
 * `remark-math` only parses `$$...$$` as *block* (display) math when the
 * fences sit on their own lines (like a fenced code block); a single line
 * `$$expr$$` parses as plain *inline* math instead, so it wouldn't get
 * KaTeX's centered/larger display rendering. The CLI's Markdown-first output
 * (and content authored by hand in `SectionEditor`) commonly writes display
 * equations as one line, so this promotes any line whose entire trimmed content
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

/** The result of {@link normalizeDisplayMathMapped}: the text the parser sees plus offset conversion both ways. */
export interface NormalizedMarkdown {
  text: string;
  /** Parser offset -> offset in the author's source. Inside a rewritten line, `bias` picks that line's start or end. */
  toOriginal: (offset: number, bias?: 'start' | 'end') => number;
  /** Author's offset -> parser offset. */
  toNormalized: (offset: number, bias?: 'start' | 'end') => number;
}

interface Rewrite {
  oStart: number;
  oEnd: number;
  nStart: number;
  nEnd: number;
}

function convert(
  rewrites: readonly Rewrite[],
  offset: number,
  bias: 'start' | 'end',
  from: 'o' | 'n',
): number {
  const startKey = from === 'o' ? 'oStart' : 'nStart';
  const endKey = from === 'o' ? 'oEnd' : 'nEnd';
  const toStart = from === 'o' ? 'nStart' : 'oStart';
  const toEnd = from === 'o' ? 'nEnd' : 'oEnd';
  // Shift accumulated by every rewrite that ends at or before `offset`.
  let shift = 0;
  for (const rewrite of rewrites) {
    if (offset >= rewrite[endKey]) {
      shift = rewrite[toEnd] - rewrite[endKey];
    } else if (offset > rewrite[startKey]) {
      return bias === 'start' ? rewrite[toStart] : rewrite[toEnd];
    } else {
      break;
    }
  }
  return offset + shift;
}

/**
 * {@link normalizeDisplayMath} plus the offset maps highlights and selections need: the rewrite
 * adds characters, so a position the parser reports is not an offset in what the author typed.
 */
export function normalizeDisplayMathMapped(markdown: string): NormalizedMarkdown {
  const rewrites: Rewrite[] = [];
  const out: string[] = [];
  let o = 0;
  let n = 0;
  const lines = markdown.split('\n');
  lines.forEach((line, index) => {
    const match = STANDALONE_DISPLAY_MATH.exec(line);
    const next = match ? `$$\n${match[1]!.trim()}\n$$` : line;
    if (match)
      rewrites.push({ oStart: o, oEnd: o + line.length, nStart: n, nEnd: n + next.length });
    out.push(next);
    o += line.length + 1;
    n += next.length + 1;
    void index;
  });
  return {
    text: out.join('\n'),
    toOriginal: (offset, bias = 'start') => convert(rewrites, offset, bias, 'n'),
    toNormalized: (offset, bias = 'start') => convert(rewrites, offset, bias, 'o'),
  };
}
