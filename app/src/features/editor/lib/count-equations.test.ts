import { describe, expect, it } from 'vitest';

import { countDisplayEquations } from './count-equations';

describe('countDisplayEquations', () => {
  it('counts multi-line $$...$$ blocks', () => {
    const markdown = 'Intro.\n\n$$\nn = 3f + 1\n$$\n\nMore text.\n\n$$\nx^2\n$$\n';
    expect(countDisplayEquations(markdown)).toBe(2);
  });

  it('counts a single-line $$...$$ block (promoted to display math)', () => {
    expect(countDisplayEquations('Intro.\n\n$$n = 3f + 1$$\n\nMore text.')).toBe(1);
  });

  it('does not count inline $...$ math', () => {
    expect(countDisplayEquations('Let $n$ and $f$ be integers.')).toBe(0);
  });

  it('does not count a literal $$ inside a fenced code block', () => {
    const markdown = '```\nconst price = "$$100";\n```\n';
    expect(countDisplayEquations(markdown)).toBe(0);
  });

  it('returns 0 for content with no math', () => {
    expect(countDisplayEquations('Just plain prose, no equations here.')).toBe(0);
  });
});
