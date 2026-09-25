import type { OutlineNode, OutlineNodeUpdate, SourceScope } from '@/api/types';

/**
 * Pure helpers over per-node source scoping (issue #138) — no React, no network. Mirrors the
 * backend's resolution rule: a node's `sourceScope` is `inherit` (use the nearest ancestor's
 * scope; a top-level node that inherits means every project source), `all`, or `selected` (only
 * `sourceIds`). Only leaf sections actually retrieve, so a container's selection matters through
 * the leaves that inherit it.
 */

/**
 * What a node actually retrieves from. `own` is whether the node itself sets this (vs inheriting
 * it); `fromNodeId` is the node that sets it — `null` only for the implicit "all sources" a
 * top-level inherit chain falls back to.
 */
export type EffectiveSourceScope =
  | { kind: 'all'; own: boolean; fromNodeId: string | null }
  | { kind: 'selected'; own: boolean; fromNodeId: string; sourceIds: string[] };

/** Nearest node at or above `node` with an explicit scope, walking `parentId` through `flat`. */
function resolveFrom(
  node: OutlineNode | undefined,
  selfId: string | null,
  flat: readonly OutlineNode[],
): EffectiveSourceScope {
  let current = node;
  while (current) {
    if (current.sourceScope === 'selected' && current.sourceIds.length > 0) {
      return {
        kind: 'selected',
        own: current.id === selfId,
        fromNodeId: current.id,
        sourceIds: current.sourceIds,
      };
    }
    if (current.sourceScope === 'all') {
      return { kind: 'all', own: current.id === selfId, fromNodeId: current.id };
    }
    const parentId = current.parentId;
    current = parentId ? flat.find((item) => item.id === parentId) : undefined;
  }
  return { kind: 'all', own: false, fromNodeId: null };
}

/** The scope `nodeId` effectively retrieves with, after resolving `inherit` up the tree. */
export function resolveSourceScope(
  nodeId: string,
  flat: readonly OutlineNode[],
): EffectiveSourceScope {
  return resolveFrom(
    flat.find((item) => item.id === nodeId),
    nodeId,
    flat,
  );
}

/** The scope `nodeId` would get if it were set to `inherit` — i.e. its parent's effective scope. */
export function inheritedSourceScope(
  nodeId: string,
  flat: readonly OutlineNode[],
): EffectiveSourceScope {
  const parentId = flat.find((item) => item.id === nodeId)?.parentId ?? null;
  const parent = parentId ? flat.find((item) => item.id === parentId) : undefined;
  return resolveFrom(parent, null, flat);
}

export interface SourceScopeImpact {
  /** Leaf sections under the node that inherit its scope (and so actually retrieve with it). */
  inheriting: OutlineNode[];
  /** Topmost descendants that set their own scope, shadowing the node's for their subtree. */
  overriding: OutlineNode[];
}

/** Which of `nodeId`'s descendants its scope applies to vs which override it, in outline order. */
export function sourceScopeImpact(nodeId: string, flat: readonly OutlineNode[]): SourceScopeImpact {
  const inheriting: OutlineNode[] = [];
  const overriding: OutlineNode[] = [];

  function walk(parentId: string): void {
    const children = flat
      .filter((item) => item.parentId === parentId)
      .sort((a, b) => a.orderIndex - b.orderIndex);
    for (const child of children) {
      if (child.sourceScope !== 'inherit') {
        overriding.push(child);
      } else if (flat.some((item) => item.parentId === child.id)) {
        walk(child.id);
      } else {
        inheriting.push(child);
      }
    }
  }

  walk(nodeId);
  return { inheriting, overriding };
}

function compareSectionNumbers(a: OutlineNode, b: OutlineNode): number {
  return a.sectionNumber.localeCompare(b.sectionNumber, undefined, { numeric: true });
}

/** Nodes that restrict retrieval to their own selection, in outline order. */
export function scopedNodes(flat: readonly OutlineNode[]): OutlineNode[] {
  return flat
    .filter((node) => node.sourceScope === 'selected' && node.sourceIds.length > 0)
    .sort(compareSectionNumbers);
}

/** For each source id, the nodes whose own selection includes it, in outline order. */
export function nodesBySource(flat: readonly OutlineNode[]): Map<string, OutlineNode[]> {
  const result = new Map<string, OutlineNode[]>();
  for (const node of scopedNodes(flat)) {
    for (const sourceId of node.sourceIds) {
      const list = result.get(sourceId);
      if (list) list.push(node);
      else result.set(sourceId, [node]);
    }
  }
  return result;
}

/** "§2.1", "§2.1 and §2.2", "§2.1, §2.2 and §2.3". */
export function formatSectionList(nodes: readonly OutlineNode[]): string {
  const labels = nodes.map((node) => `§${node.sectionNumber}`);
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * Applies a PATCH body's scope fields to `current` the way the backend does: `inherit`/`all`
 * clear `sourceIds`, `sourceIds` alone implies `selected`, and absent fields keep their values.
 */
export function mergeSourceScope(
  current: Pick<OutlineNode, 'sourceScope' | 'sourceIds'>,
  body: Pick<OutlineNodeUpdate, 'sourceScope' | 'sourceIds'>,
): { sourceScope: SourceScope; sourceIds: string[] } {
  const ids = body.sourceIds ?? undefined;
  const scope = body.sourceScope ?? (ids !== undefined ? 'selected' : undefined);
  if (scope === undefined)
    return { sourceScope: current.sourceScope, sourceIds: current.sourceIds };
  if (scope !== 'selected') return { sourceScope: scope, sourceIds: [] };
  return { sourceScope: 'selected', sourceIds: [...new Set(ids ?? current.sourceIds)] };
}
