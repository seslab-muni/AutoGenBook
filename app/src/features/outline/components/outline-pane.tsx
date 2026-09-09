import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronsDownUp,
  ChevronsUpDown,
  ListTree,
  Lock,
  Plus,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { ApiError } from '@/api/client';
import {
  outline,
  useCreateOutlineNodeMutation,
  useDeleteOutlineNodeMutation,
} from '@/api/queries/outline';
import type { OutlineNode } from '@/api/types';
import { EmptyState } from '@/components/empty-state';
import { PaneStatusBar } from '@/components/layout/pane-status-bar';
import { PaneToolbar } from '@/components/layout/pane-toolbar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DeleteNodeDialog } from '@/features/outline/components/delete-node-dialog';
import { NodePropertiesSheet } from '@/features/outline/components/node-properties-sheet';
import { OutlineDraftEditor } from '@/features/outline/components/outline-draft-editor';
import {
  OutlineRow,
  STRUCTURE_LOCKED_MESSAGE,
  type OutlineRowActions,
} from '@/features/outline/components/outline-row';
import {
  ancestorIds,
  buildTree,
  filterTree,
  nodeMatches,
  type OutlineTree,
} from '@/features/outline/model';
import { useActiveRun } from '@/features/runs/hooks/use-active-run';
import { useOutlineStore } from '@/stores/outline-store';
import { useUiStore } from '@/stores/ui-store';

/** Outlines above this size default to collapsed on first load (issue #115). */
const SEED_COLLAPSE_THRESHOLD = 30;
/** Debounce for the filter input so typing on a large tree doesn't re-filter every keystroke. */
const FILTER_DEBOUNCE_MS = 150;

interface OutlinePaneProps {
  projectId: string;
  maxOutlineLevels: number;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
}

export function OutlinePane({
  projectId,
  maxOutlineLevels,
  selectedNodeId,
  onSelectNode,
}: OutlinePaneProps) {
  const { data } = useQuery(outline.flat(projectId));
  const flat = useMemo(() => data?.items ?? [], [data]);
  const tree = useMemo(() => buildTree(flat), [flat]);

  const collapsedArray = useOutlineStore((state) => state.collapsedByProject[projectId]);
  const collapsedIds = useMemo(() => new Set(collapsedArray ?? []), [collapsedArray]);
  const toggleCollapsed = useOutlineStore((state) => state.toggleCollapsed);
  const expand = useOutlineStore((state) => state.expand);
  const seedCollapsed = useOutlineStore((state) => state.seedCollapsed);
  const seeded = useOutlineStore((state) => Boolean(state.seededByProject[projectId]));
  const expandAllAction = useOutlineStore((state) => state.expandAll);
  const collapseAllAction = useOutlineStore((state) => state.collapseAll);

  const [deletingNode, setDeletingNode] = useState<OutlineNode | null>(null);
  const [propertiesNodeId, setPropertiesNodeId] = useState<string | null>(null);
  const [draftEditorOpen, setDraftEditorOpen] = useState(false);
  const [filterInput, setFilterInput] = useState('');
  const [filterQuery, setFilterQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setFilterQuery(filterInput), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filterInput]);

  const isFiltering = filterQuery.trim().length > 0;
  const filteredTree = useMemo(() => filterTree(tree, filterQuery), [tree, filterQuery]);
  const matchCount = useMemo(
    () => (isFiltering ? flat.filter((node) => nodeMatches(node, filterQuery)).length : flat.length),
    [flat, filterQuery, isFiltering],
  );

  const createMutation = useCreateOutlineNodeMutation(projectId);
  const deleteMutation = useDeleteOutlineNodeMutation(projectId);
  const openModal = useUiStore((state) => state.openModal);
  const { activeRun, sectionNodeIds } = useActiveRun(projectId);
  // The backend rejects every structural outline write (create/delete/move) with 409 while the
  // project has a queued/running run (`OutlineService._reject_if_run_active`, issue #74) — mirror
  // that here so the controls are disabled instead of silently 409ing. Rename/summary/content
  // edits stay enabled, matching what the backend still allows.
  const structuralEditsDisabled = Boolean(activeRun);

  const isGenerating = useCallback(
    (node: OutlineNode) => {
      if (!activeRun) return false;
      if (activeRun.kind === 'regenerate_section') return activeRun.targetNodeId === node.id;
      if (activeRun.kind === 'full') return !sectionNodeIds.has(node.cliKey ?? node.id);
      return false;
    },
    [activeRun, sectionNodeIds],
  );

  // Auto-expand the path to the selected node whenever the selection changes.
  useEffect(() => {
    if (selectedNodeId && flat.length > 0) {
      expand(projectId, ancestorIds(selectedNodeId, flat));
    }
  }, [selectedNodeId, flat, projectId, expand]);

  // One-time default-collapse for a large outline on first load — no-ops once seeded. Keeps the
  // path to the initially-selected node expanded; the effect above stays authoritative afterwards.
  useEffect(() => {
    if (seeded || flat.length <= SEED_COLLAPSE_THRESHOLD) return;
    const nodesWithChildren = flat
      .filter((node) => flat.some((child) => child.parentId === node.id))
      .map((node) => node.id);
    const keepExpanded = selectedNodeId ? ancestorIds(selectedNodeId, flat) : [];
    seedCollapsed(projectId, nodesWithChildren, keepExpanded);
  }, [seeded, flat, projectId, selectedNodeId, seedCollapsed]);

  const handleAddChild = useCallback(
    (parentId: string | null) => {
      const depth = parentId ? (flat.find((n) => n.id === parentId)?.level ?? 0) + 1 : 1;
      createMutation.mutate(
        { parentId, title: depth <= 1 ? 'Untitled chapter' : 'Untitled section' },
        {
          onSuccess: (node) => {
            onSelectNode(node.id);
            if (parentId) expand(projectId, [parentId]);
          },
          onError: (error) => {
            const problem = error instanceof ApiError ? error.problem : undefined;
            toast.error(problem?.detail ?? problem?.title ?? 'Could not add section');
          },
        },
      );
    },
    [flat, createMutation, onSelectNode, expand, projectId],
  );

  const handleConfirmDelete = useCallback(
    (nodeId: string) => {
      deleteMutation.mutate(nodeId, {
        onSuccess: () => {
          if (selectedNodeId === nodeId) onSelectNode(null);
          setDeletingNode(null);
        },
        onError: (error) => {
          const problem = error instanceof ApiError ? error.problem : undefined;
          toast.error(problem?.detail ?? problem?.title ?? 'Could not delete section');
        },
      });
    },
    [deleteMutation, selectedNodeId, onSelectNode],
  );

  const visibleIds = useMemo(() => {
    const result: string[] = [];
    function walk(nodes: readonly OutlineTree[]) {
      for (const entry of nodes) {
        result.push(entry.node.id);
        // While filtering, every remaining node is force-expanded (see `isCollapsed` below).
        if (isFiltering || !collapsedIds.has(entry.node.id)) walk(entry.children);
      }
    }
    walk(filteredTree);
    return result;
  }, [filteredTree, collapsedIds, isFiltering]);

  const handleKeyNavigate = useCallback(
    (nodeId: string, key: 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Delete') => {
      if (key === 'Enter') return;
      if (key === 'Delete') {
        if (structuralEditsDisabled) return;
        const node = flat.find((n) => n.id === nodeId);
        if (node) setDeletingNode(node);
        return;
      }
      const index = visibleIds.indexOf(nodeId);
      if (index === -1) return;
      const nextIndex = key === 'ArrowUp' ? index - 1 : index + 1;
      const nextId = visibleIds[nextIndex];
      if (nextId) onSelectNode(nextId);
    },
    [flat, visibleIds, onSelectNode, structuralEditsDisabled],
  );

  const handleToggleCollapse = useCallback(
    (nodeId: string) => toggleCollapsed(projectId, nodeId),
    [toggleCollapsed, projectId],
  );

  // While filtering, ignore the persisted collapsed set entirely instead of mutating it, so
  // clearing the query restores the user's own expand/collapse shape.
  const isCollapsed = useCallback(
    (nodeId: string) => !isFiltering && collapsedIds.has(nodeId),
    [collapsedIds, isFiltering],
  );

  const handleExpandAll = useCallback(() => expandAllAction(projectId), [expandAllAction, projectId]);
  const handleCollapseAll = useCallback(() => {
    const nodesWithChildren = flat
      .filter((node) => flat.some((child) => child.parentId === node.id))
      .map((node) => node.id);
    collapseAllAction(projectId, nodesWithChildren);
  }, [collapseAllAction, projectId, flat]);

  const actions: OutlineRowActions = useMemo(
    () => ({
      onSelect: onSelectNode,
      onToggleCollapse: handleToggleCollapse,
      onAddChild: handleAddChild,
      onDelete: setDeletingNode,
      onOpenProperties: setPropertiesNodeId,
      onKeyNavigate: handleKeyNavigate,
    }),
    [onSelectNode, handleToggleCollapse, handleAddChild, handleKeyNavigate],
  );

  const propertiesNode = propertiesNodeId
    ? (flat.find((n) => n.id === propertiesNodeId) ?? null)
    : null;

  return (
    <>
      <PaneToolbar>
        <span className="text-xs font-semibold text-foreground">Outline</span>
        <div className="flex items-center gap-1">
          {tree.length > 0 ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Expand all"
                    onClick={handleExpandAll}
                  >
                    <ChevronsUpDown className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Expand all</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Collapse all"
                    onClick={handleCollapseAll}
                  >
                    <ChevronsDownUp className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Collapse all</TooltipContent>
              </Tooltip>
            </>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => handleAddChild(null)}
            disabled={maxOutlineLevels < 1 || structuralEditsDisabled}
            title={structuralEditsDisabled ? STRUCTURE_LOCKED_MESSAGE : undefined}
          >
            <Plus className="size-3.5" />
            Add chapter
          </Button>
        </div>
      </PaneToolbar>

      {tree.length > 0 ? (
        <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filterInput}
              onChange={(event) => setFilterInput(event.target.value)}
              placeholder="Filter sections…"
              aria-label="Filter outline sections"
              className="h-7 pr-7 pl-7 text-xs"
            />
            {filterInput ? (
              <button
                type="button"
                aria-label="Clear filter"
                className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => setFilterInput('')}
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {structuralEditsDisabled ? (
        <div className="flex items-center gap-2 border-b bg-warning/10 px-3 py-2 text-xs font-medium text-warning-foreground">
          <Lock className="size-3.5 shrink-0" />
          {STRUCTURE_LOCKED_MESSAGE}
        </div>
      ) : null}

      <div className="custom-scrollbar flex-1 overflow-auto p-1.5" role="tree">
        {tree.length === 0 ? (
          <EmptyState
            icon={ListTree}
            title="No outline yet"
            description="Add a chapter, author the whole outline at once, or let a full run plan and draft it."
            action={
              <div className="flex flex-col items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setDraftEditorOpen(true)}
                  disabled={structuralEditsDisabled}
                  title={structuralEditsDisabled ? STRUCTURE_LOCKED_MESSAGE : undefined}
                >
                  Paste or author an outline
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => openModal('start-run')}
                >
                  <Sparkles className="size-3.5" />
                  Plan outline with AutoGenBook
                </Button>
              </div>
            }
          />
        ) : isFiltering && filteredTree.length === 0 ? (
          <EmptyState icon={Search} title="No sections match" description={`No section title or number contains "${filterQuery.trim()}".`} />
        ) : (
          filteredTree.map((entry) => (
            <OutlineRow
              key={entry.node.id}
              projectId={projectId}
              entry={entry}
              flat={flat}
              depth={0}
              maxOutlineLevels={maxOutlineLevels}
              selectedNodeId={selectedNodeId}
              isCollapsed={isCollapsed}
              isGenerating={isGenerating}
              {...(isFiltering ? { highlightQuery: filterQuery.trim() } : {})}
              structuralEditsDisabled={structuralEditsDisabled}
              actions={actions}
            />
          ))
        )}
      </div>

      <PaneStatusBar>
        {isFiltering
          ? `${matchCount} of ${flat.length} node${flat.length === 1 ? '' : 's'}`
          : `${flat.length} node${flat.length === 1 ? '' : 's'}`}
      </PaneStatusBar>

      <DeleteNodeDialog
        node={deletingNode}
        flat={flat}
        onOpenChange={(open) => {
          if (!open) setDeletingNode(null);
        }}
        onConfirm={handleConfirmDelete}
      />
      <NodePropertiesSheet
        projectId={projectId}
        node={propertiesNode}
        onOpenChange={(open) => {
          if (!open) setPropertiesNodeId(null);
        }}
      />
      <OutlineDraftEditor
        projectId={projectId}
        maxOutlineLevels={maxOutlineLevels}
        open={draftEditorOpen}
        onOpenChange={setDraftEditorOpen}
      />
    </>
  );
}
