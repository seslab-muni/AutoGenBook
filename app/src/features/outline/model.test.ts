import { describe, expect, it } from 'vitest';

import type { OutlineNode } from '@/api/types';

import {
  ancestorIds,
  assignPositions,
  buildTree,
  childrenOf,
  depthOf,
  descendantIds,
  flattenTree,
  isLeaf,
  nextOrderIndex,
} from './model';

function node(overrides: Partial<OutlineNode> & Pick<OutlineNode, 'id'>): OutlineNode {
  return {
    parentId: overrides.parentId ?? null,
    orderIndex: overrides.orderIndex ?? 0,
    cliKey: overrides.cliKey ?? null,
    title: overrides.title ?? overrides.id,
    summary: '',
    level: overrides.level ?? 0,
    sectionNumber: overrides.sectionNumber ?? '',
    status: 'not_started',
    targetPages: 1,
    wordBudget: 350,
    actualWords: 0,
    equationDensityLevel: 3,
    mathLevel: 'rigorous',
    subPrompt: null,
    contentMarkdown: '',
    contentLatex: '',
    ragCitations: [],
    reviewerScore: null,
    reviewerNotes: null,
    structureLocked: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// chapter1 -> section11, section12; chapter2 (root)
const FLAT: OutlineNode[] = [
  node({ id: 'chapter1', parentId: null, orderIndex: 0 }),
  node({ id: 'chapter2', parentId: null, orderIndex: 1 }),
  node({ id: 'section11', parentId: 'chapter1', orderIndex: 0 }),
  node({ id: 'section12', parentId: 'chapter1', orderIndex: 1 }),
];

describe('assignPositions', () => {
  it('derives level/sectionNumber/cliKey from parentId/orderIndex', () => {
    const positioned = assignPositions(FLAT);
    const byId = new Map(positioned.map((n) => [n.id, n]));

    expect(byId.get('chapter1')).toMatchObject({ level: 1, sectionNumber: '1', cliKey: '1' });
    expect(byId.get('chapter2')).toMatchObject({ level: 1, sectionNumber: '2', cliKey: '2' });
    expect(byId.get('section11')).toMatchObject({ level: 2, sectionNumber: '1.1', cliKey: '1-1' });
    expect(byId.get('section12')).toMatchObject({ level: 2, sectionNumber: '1.2', cliKey: '1-2' });
  });

  it('preserves input order and does not mutate inputs', () => {
    const positioned = assignPositions(FLAT);
    expect(positioned.map((n) => n.id)).toEqual(FLAT.map((n) => n.id));
    expect(FLAT[0]?.level).toBe(0);
  });
});

describe('buildTree / flattenTree', () => {
  it('nests root nodes with their children', () => {
    const tree = buildTree(FLAT);
    expect(tree.map((t) => t.node.id)).toEqual(['chapter1', 'chapter2']);
    expect(tree[0]?.children.map((t) => t.node.id)).toEqual(['section11', 'section12']);
    expect(tree[1]?.children).toEqual([]);
  });

  it('flattenTree is the inverse of buildTree (pre-order)', () => {
    const tree = buildTree(FLAT);
    expect(flattenTree(tree).map((n) => n.id)).toEqual([
      'chapter1',
      'section11',
      'section12',
      'chapter2',
    ]);
  });
});

describe('childrenOf / isLeaf', () => {
  it('returns direct children ordered by orderIndex', () => {
    expect(childrenOf('chapter1', FLAT).map((n) => n.id)).toEqual(['section11', 'section12']);
    expect(childrenOf(null, FLAT).map((n) => n.id)).toEqual(['chapter1', 'chapter2']);
  });

  it('isLeaf is true only for nodes with no children', () => {
    expect(isLeaf('chapter1', FLAT)).toBe(false);
    expect(isLeaf('section11', FLAT)).toBe(true);
    expect(isLeaf('chapter2', FLAT)).toBe(true);
  });
});

describe('depthOf / ancestorIds', () => {
  it('depthOf is 1-based', () => {
    expect(depthOf('chapter1', FLAT)).toBe(1);
    expect(depthOf('section11', FLAT)).toBe(2);
    expect(depthOf('missing', FLAT)).toBe(0);
  });

  it('ancestorIds lists parents nearest-first', () => {
    expect(ancestorIds('section11', FLAT)).toEqual(['chapter1']);
    expect(ancestorIds('chapter1', FLAT)).toEqual([]);
  });
});

describe('descendantIds', () => {
  it('excludes the node itself', () => {
    expect(descendantIds('chapter1', FLAT)).toEqual(new Set(['section11', 'section12']));
    expect(descendantIds('section11', FLAT)).toEqual(new Set());
  });
});

describe('nextOrderIndex', () => {
  it('is 0 for the first child, max+1 otherwise', () => {
    expect(nextOrderIndex(null, [])).toBe(0);
    expect(nextOrderIndex(null, FLAT)).toBe(2);
    expect(nextOrderIndex('chapter1', FLAT)).toBe(2);
  });
});
