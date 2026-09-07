import type { OutlineNode } from '@/api/types';

/**
 * Pure functions over outline nodes — no React, no network. Mirrors
 * `api/domain/outline.py`'s tree/position math so the client can compute
 * optimistic `sectionNumber`/`level`/`cliKey` values for rows the server
 * hasn't confirmed yet, and so `OutlinePane` can render/navigate the tree
 * without waiting on a `?format=tree` refetch.
 */

export interface OutlineTree {
  node: OutlineNode;
  children: OutlineTree[];
}

function siblingsByParent(flat: readonly OutlineNode[]): Map<string | null, OutlineNode[]> {
  const byParent = new Map<string | null, OutlineNode[]>();
  for (const node of flat) {
    const list = byParent.get(node.parentId);
    if (list) list.push(node);
    else byParent.set(node.parentId, [node]);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.orderIndex - b.orderIndex);
  return byParent;
}

/**
 * Returns copies of `flat` with `level`, `sectionNumber` ("1.2.1") and
 * `cliKey` ("1-2-1") recomputed from the current `parentId`/`orderIndex`
 * structure — 1-based, matching `api/domain/outline.py:assign_positions`.
 * Output preserves input order; inputs are never mutated.
 */
export function assignPositions(flat: readonly OutlineNode[]): OutlineNode[] {
  const byParent = siblingsByParent(flat);
  const positioned = new Map<string, OutlineNode>();

  function walk(parentId: string | null, path: readonly number[]): void {
    const siblings = byParent.get(parentId) ?? [];
    siblings.forEach((node, index) => {
      const nodePath = [...path, index + 1];
      positioned.set(node.id, {
        ...node,
        level: nodePath.length,
        sectionNumber: nodePath.join('.'),
        cliKey: nodePath.join('-'),
      });
      walk(node.id, nodePath);
    });
  }

  walk(null, []);
  return flat.map((node) => positioned.get(node.id) ?? node);
}

/** Nests a flat, positioned node list into root-level `OutlineTree`s. */
export function buildTree(flat: readonly OutlineNode[]): OutlineTree[] {
  const positioned = assignPositions(flat);
  const byParent = siblingsByParent(positioned);

  function build(parentId: string | null): OutlineTree[] {
    return (byParent.get(parentId) ?? []).map((node) => ({ node, children: build(node.id) }));
  }

  return build(null);
}

/** Inverse of `buildTree`: pre-order flatten nested `OutlineTree`s back into a flat list. */
export function flattenTree(tree: readonly OutlineTree[]): OutlineNode[] {
  const result: OutlineNode[] = [];

  function walk(nodes: readonly OutlineTree[]): void {
    for (const entry of nodes) {
      result.push(entry.node);
      walk(entry.children);
    }
  }

  walk(tree);
  return result;
}

/** Direct children of `parentId`, ordered by `orderIndex`. */
export function childrenOf(parentId: string | null, flat: readonly OutlineNode[]): OutlineNode[] {
  return flat.filter((node) => node.parentId === parentId).sort((a, b) => a.orderIndex - b.orderIndex);
}

export function isLeaf(nodeId: string, flat: readonly OutlineNode[]): boolean {
  return !flat.some((node) => node.parentId === nodeId);
}

/** 1-based depth of `nodeId` in `flat` (a root node has depth 1); 0 if not found. */
export function depthOf(nodeId: string, flat: readonly OutlineNode[]): number {
  const byId = new Map(flat.map((node) => [node.id, node]));
  let depth = 0;
  let current: OutlineNode | undefined = byId.get(nodeId);
  while (current) {
    depth += 1;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return depth;
}

/** Ids of every ancestor of `nodeId`, nearest first — used to auto-expand a path to a selection. */
export function ancestorIds(nodeId: string, flat: readonly OutlineNode[]): string[] {
  const byId = new Map(flat.map((node) => [node.id, node]));
  const result: string[] = [];
  let current = byId.get(nodeId)?.parentId ?? null;
  while (current) {
    result.push(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return result;
}

/** Ids of every descendant of `nodeId` (not including itself), per `flat`'s parent links. */
export function descendantIds(nodeId: string, flat: readonly OutlineNode[]): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const node of flat) {
    if (node.parentId !== null) {
      const list = childrenByParent.get(node.parentId);
      if (list) list.push(node.id);
      else childrenByParent.set(node.parentId, [node.id]);
    }
  }
  const result = new Set<string>();
  const stack = [nodeId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    for (const childId of childrenByParent.get(current) ?? []) {
      if (!result.has(childId)) {
        result.add(childId);
        stack.push(childId);
      }
    }
  }
  return result;
}

/** `orderIndex` a new last-sibling child of `parentId` should get. */
export function nextOrderIndex(parentId: string | null, flat: readonly OutlineNode[]): number {
  const siblings = childrenOf(parentId, flat);
  if (siblings.length === 0) return 0;
  return Math.max(...siblings.map((node) => node.orderIndex)) + 1;
}
