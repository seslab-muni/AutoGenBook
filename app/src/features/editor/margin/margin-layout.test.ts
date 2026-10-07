import { describe, expect, it } from 'vitest';

import { layoutMargin, type LayoutItem } from './margin-layout';

const item = (id: string, y: number, height = 100): LayoutItem => ({ id, y, height });

describe('layoutMargin', () => {
  it('leaves well-separated cards at their anchors', () => {
    const tops = layoutMargin([item('a', 0), item('b', 300), item('c', 700)]);
    expect([...tops.values()]).toEqual([0, 300, 700]);
  });

  it('pushes overlapping cards down, cascading', () => {
    const tops = layoutMargin([item('a', 50), item('b', 60), item('c', 70)], { gap: 8 });
    expect(tops.get('a')).toBe(50);
    expect(tops.get('b')).toBe(158);
    expect(tops.get('c')).toBe(266);
  });

  it('sorts by y regardless of input order and breaks ties by input order', () => {
    const tops = layoutMargin([item('late', 500), item('x', 100), item('y', 100)], { gap: 0 });
    expect(tops.get('x')).toBe(100);
    expect(tops.get('y')).toBe(200);
    expect(tops.get('late')).toBe(500);
  });

  it('never leaves overlaps for any mix of positions', () => {
    const items = Array.from({ length: 120 }, (_, i) =>
      item(`c${i}`, (i * 37) % 900, 40 + (i % 5) * 30),
    );
    const tops = layoutMargin(items, { gap: 6 });
    const placed = [...items].sort((a, b) => tops.get(a.id)! - tops.get(b.id)!);
    for (let i = 1; i < placed.length; i += 1) {
      expect(tops.get(placed[i]!.id)!).toBeGreaterThanOrEqual(
        tops.get(placed[i - 1]!.id)! + placed[i - 1]!.height + 6,
      );
    }
  });

  it('respects minTop', () => {
    const tops = layoutMargin([item('a', 0), item('b', 10)], { minTop: 40, gap: 0 });
    expect(tops.get('a')).toBe(40);
    expect(tops.get('b')).toBe(140);
  });

  it('keeps a focused card on its anchor and pushes the earlier ones up', () => {
    const items = [item('a', 400), item('b', 410), item('c', 420)];
    const plain = layoutMargin(items, { gap: 8 });
    expect(plain.get('c')).toBe(400 + 2 * 108);
    const tops = layoutMargin(items, { gap: 8, focusedId: 'c' });
    expect(tops.get('c')).toBe(420);
    expect(tops.get('b')).toBe(420 - 8 - 100);
    expect(tops.get('a')).toBe(tops.get('b')! - 8 - 100);
  });

  it('falls back to the plain layout when pushing up would cross the top', () => {
    const items = [item('a', 0), item('b', 10)];
    const tops = layoutMargin(items, { gap: 8, focusedId: 'b' });
    expect(tops.get('a')).toBe(0);
    expect(tops.get('b')).toBe(108);
  });

  it('pushes cards after the focused one down', () => {
    const tops = layoutMargin([item('a', 0, 40), item('b', 50), item('c', 60)], {
      gap: 8,
      focusedId: 'b',
    });
    expect(tops.get('b')).toBe(50);
    expect(tops.get('c')).toBe(158);
  });
});
