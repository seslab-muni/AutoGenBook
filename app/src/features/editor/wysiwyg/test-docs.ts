/** Seeded random Markdown documents for the property tests (issue #182, phase 5). */

export function rng(seed: number): () => number {
  // Mixed and warmed up: xorshift's first outputs for small seeds are all close to zero.
  let s = (Math.imul(seed >>> 0 || 1, 2654435761) ^ 0x9e3779b9) >>> 0 || 1;
  const step = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
  for (let i = 0; i < 12; i += 1) step();
  return step;
}

const WORDS = [
  'alpha',
  'beta',
  'gamma',
  'quorum',
  'protocol',
  'node',
  'proof',
  'the',
  'of',
  'and',
  'naïve',
  'café',
  'データ',
  '𝒳',
  '😀',
  'x_1',
  '5',
  "don't",
];

type Pick = <T>(items: readonly T[]) => T;

function phrase(pick: Pick, next: () => number, min = 2, max = 9): string {
  const n = min + Math.floor(next() * (max - min + 1));
  return Array.from({ length: n }, () => pick(WORDS)).join(' ');
}

function inline(pick: Pick, next: () => number): string {
  const pieces: string[] = [phrase(pick, next)];
  const extras = Math.floor(next() * 4);
  for (let i = 0; i < extras; i += 1) {
    pieces.push(
      pick([
        `**${phrase(pick, next, 1, 3)}**`,
        `*${phrase(pick, next, 1, 3)}*`,
        `_${phrase(pick, next, 1, 3)}_`,
        `\`${pick(WORDS)}\``,
        `[${phrase(pick, next, 1, 2)}](https://example.com/${pick(WORDS).length})`,
        '$x^2 + y$',
        '$$a+b$$',
        '[@lamport_1982]',
        '\\cite{castro_1999}',
        '\\*literal\\*',
        '&amp;',
        '<span>raw</span>',
        '![fig](a.png)',
        '~~gone~~',
        'plain tail',
      ]),
    );
    pieces.push(phrase(pick, next, 1, 4));
  }
  return pieces.join(' ');
}

function block(pick: Pick, next: () => number, depth: number): string {
  const kinds =
    depth > 1
      ? ['p', 'p', 'h']
      : [
          'p',
          'p',
          'p',
          'h',
          'ul',
          'ol',
          'quote',
          'code',
          'math',
          'table',
          'callout',
          'hr',
          'html',
          'foot',
        ];
  switch (pick(kinds)) {
    case 'h':
      return `${'#'.repeat(1 + Math.floor(next() * 4))} ${phrase(pick, next, 1, 5)}`;
    case 'ul': {
      const marker = pick(['-', '*', '+']);
      const items = 1 + Math.floor(next() * 3);
      return Array.from({ length: items }, () => {
        const body = inline(pick, next);
        const nested = depth < 2 && next() < 0.3 ? `\n  ${marker} ${phrase(pick, next, 1, 4)}` : '';
        return `${marker} ${body}${nested}`;
      }).join(next() < 0.2 ? '\n\n' : '\n');
    }
    case 'ol': {
      const items = 1 + Math.floor(next() * 3);
      return Array.from({ length: items }, (_, i) => `${i + 1}. ${inline(pick, next)}`).join('\n');
    }
    case 'quote':
      return `> ${inline(pick, next)}\n> ${phrase(pick, next)}`;
    case 'code':
      return `\`\`\`${pick(['', 'python', 'ts'])}\n${phrase(pick, next)}\n\n    indented ${pick(WORDS)}\n\`\`\``;
    case 'math':
      return `$$\n${phrase(pick, next, 1, 3)} = 1\n$$`;
    case 'table':
      return '| a | b |\n| - | - |\n| 1 | $x$ |';
    case 'callout':
      return `> **Theorem 1.${Math.floor(next() * 9)}**: ${inline(pick, next)}`;
    case 'hr':
      return pick(['---', '***', '___']);
    case 'html':
      return '<div class="x">\nhello\n</div>';
    case 'foot':
      return '[^1]: A footnote.';
    default:
      return inline(pick, next) + (next() < 0.15 ? '\nsecond line of the paragraph' : '');
  }
}

/** Small sections of the engine's golden output (copied here): real documents for the property tests. */
const goldenFiles = import.meta.glob('./fixtures/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
export const goldenDocuments: string[] = Object.keys(goldenFiles)
  .sort()
  .map((name) => goldenFiles[name]!.replace(/\r\n?/g, '\n'));

export interface DocumentOptions {
  /** Blocks are often separated by a single newline (where the Markdown allows it) instead of a blank line. */
  tight?: boolean;
}

/**
 * A random document: blocks separated by blank lines (sometimes more, and with `tight`, often by one
 * newline), with optional leading/trailing whitespace.
 */
export function randomDocument(seed: number, options: DocumentOptions = {}): string {
  const next = rng(seed);
  const pick: Pick = (items) => items[Math.floor(next() * items.length)]!;
  const count = 1 + Math.floor(next() * 8);
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) parts.push(block(pick, next, 0));
  const lead = next() < 0.1 ? '\n' : '';
  const trail = pick(['', '\n', '\n\n', '  \n']);
  return (
    lead +
    parts
      .map(
        (p, i) =>
          (i === 0
            ? ''
            : options.tight
              ? pick(['\n', '\n', '\n\n', '\n \n'])
              : pick(['\n\n', '\n\n', '\n\n', '\n\n\n'])) + p,
      )
      .join('') +
    trail
  );
}
