import { describe, expect, it } from 'vitest';

import type { OutlineNode } from '@/api/types';

import {
  formatSectionList,
  inheritedSourceScope,
  mergeSourceScope,
  nodesBySource,
  resolveSourceScope,
  scopedNodes,
  sourceScopeImpact,
} from './source-scope';

function node(overrides: Partial<OutlineNode> & Pick<OutlineNode, 'id'>): OutlineNode {
  return {
    parentId: null,
    orderIndex: 0,
    cliKey: null,
    title: overrides.id,
    summary: '',
    level: 1,
    sectionNumber: '',
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
    sourceScope: 'inherit',
    sourceIds: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// §1 (unscoped) -> §1.1
// §2 (selected a,b) -> §2.1, §2.2 (all), §2.3 (selected c) -> §2.3.1
// §3 (all) -> §3.1
const FLAT: OutlineNode[] = [
  node({ id: 'ch1', sectionNumber: '1', orderIndex: 0 }),
  node({ id: 's11', parentId: 'ch1', sectionNumber: '1.1' }),
  node({
    id: 'ch2',
    sectionNumber: '2',
    orderIndex: 1,
    sourceScope: 'selected',
    sourceIds: ['a', 'b'],
  }),
  node({ id: 's21', parentId: 'ch2', sectionNumber: '2.1', orderIndex: 0 }),
  node({ id: 's22', parentId: 'ch2', sectionNumber: '2.2', orderIndex: 1, sourceScope: 'all' }),
  node({
    id: 's23',
    parentId: 'ch2',
    sectionNumber: '2.3',
    orderIndex: 2,
    sourceScope: 'selected',
    sourceIds: ['c', 'a'],
  }),
  node({ id: 's231', parentId: 's23', sectionNumber: '2.3.1' }),
  node({ id: 'ch3', sectionNumber: '3', orderIndex: 2, sourceScope: 'all' }),
  node({ id: 's31', parentId: 'ch3', sectionNumber: '3.1' }),
];

describe('resolveSourceScope', () => {
  it('falls back to all sources when nothing up the chain is scoped', () => {
    expect(resolveSourceScope('s11', FLAT)).toEqual({ kind: 'all', own: false, fromNodeId: null });
    expect(resolveSourceScope('ch1', FLAT)).toEqual({ kind: 'all', own: false, fromNodeId: null });
  });

  it("returns a node's own selection", () => {
    expect(resolveSourceScope('ch2', FLAT)).toEqual({
      kind: 'selected',
      own: true,
      fromNodeId: 'ch2',
      sourceIds: ['a', 'b'],
    });
  });

  it('inherits the nearest scoped ancestor', () => {
    expect(resolveSourceScope('s21', FLAT)).toMatchObject({
      kind: 'selected',
      own: false,
      fromNodeId: 'ch2',
    });
    expect(resolveSourceScope('s231', FLAT)).toMatchObject({
      kind: 'selected',
      own: false,
      fromNodeId: 's23',
      sourceIds: ['c', 'a'],
    });
    expect(resolveSourceScope('s31', FLAT)).toEqual({ kind: 'all', own: false, fromNodeId: 'ch3' });
  });

  it('treats an explicit "all" as an own scope that shadows the ancestor', () => {
    expect(resolveSourceScope('s22', FLAT)).toEqual({ kind: 'all', own: true, fromNodeId: 's22' });
  });
});

describe('inheritedSourceScope', () => {
  it("is the parent's effective scope, ignoring the node's own", () => {
    expect(inheritedSourceScope('s23', FLAT)).toMatchObject({
      kind: 'selected',
      fromNodeId: 'ch2',
    });
    expect(inheritedSourceScope('ch2', FLAT)).toEqual({
      kind: 'all',
      own: false,
      fromNodeId: null,
    });
  });
});

describe('sourceScopeImpact', () => {
  it('splits descendants into inheriting leaves and overriding nodes', () => {
    const impact = sourceScopeImpact('ch2', FLAT);
    expect(impact.inheriting.map((n) => n.id)).toEqual(['s21']);
    expect(impact.overriding.map((n) => n.id)).toEqual(['s22', 's23']);
  });

  it('is empty for a leaf', () => {
    expect(sourceScopeImpact('s21', FLAT)).toEqual({ inheriting: [], overriding: [] });
  });
});

describe('scopedNodes / nodesBySource', () => {
  it('lists selected nodes in outline order', () => {
    expect(scopedNodes(FLAT).map((n) => n.sectionNumber)).toEqual(['2', '2.3']);
  });

  it('maps each source to the nodes whose own selection holds it', () => {
    const bySource = nodesBySource(FLAT);
    expect(bySource.get('a')?.map((n) => n.id)).toEqual(['ch2', 's23']);
    expect(bySource.get('c')?.map((n) => n.id)).toEqual(['s23']);
    expect(bySource.has('d')).toBe(false);
  });
});

describe('formatSectionList', () => {
  it('joins with commas and a final "and"', () => {
    const [a, b, c] = [FLAT[3]!, FLAT[4]!, FLAT[5]!];
    expect(formatSectionList([a])).toBe('§2.1');
    expect(formatSectionList([a, b])).toBe('§2.1 and §2.2');
    expect(formatSectionList([a, b, c])).toBe('§2.1, §2.2 and §2.3');
  });
});

describe('mergeSourceScope', () => {
  const current = { sourceScope: 'selected' as const, sourceIds: ['a'] };

  it('keeps the current scope when the body has none', () => {
    expect(mergeSourceScope(current, { sourceScope: null })).toEqual(current);
  });

  it('clears ids for inherit/all', () => {
    expect(mergeSourceScope(current, { sourceScope: 'inherit' })).toEqual({
      sourceScope: 'inherit',
      sourceIds: [],
    });
    expect(mergeSourceScope(current, { sourceScope: 'all' })).toEqual({
      sourceScope: 'all',
      sourceIds: [],
    });
  });

  it('treats ids alone as "selected", de-duplicated', () => {
    expect(
      mergeSourceScope({ sourceScope: 'inherit', sourceIds: [] }, { sourceIds: ['b', 'b', 'c'] }),
    ).toEqual({ sourceScope: 'selected', sourceIds: ['b', 'c'] });
  });
});
