import { memo, useEffect, useRef } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  Lock,
  Plus,
  Settings2,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { ApiError } from '@/api/client';
import { useUpdateOutlineNodeMutation } from '@/api/queries/outline';
import type { OutlineNode } from '@/api/types';
import { InlineEdit } from '@/components/inline-edit';
import { StatusBadge } from '@/components/status-badge';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { childrenOf, type OutlineTree } from '@/features/outline/model';
import { cn } from '@/lib/utils';

export interface OutlineRowActions {
  onSelect: (nodeId: string) => void;
  onToggleCollapse: (nodeId: string) => void;
  onAddChild: (parentId: string) => void;
  onDelete: (node: OutlineNode) => void;
  onOpenProperties: (nodeId: string) => void;
  onKeyNavigate: (nodeId: string, key: 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Delete') => void;
}

interface OutlineRowProps {
  projectId: string;
  entry: OutlineTree;
  flat: readonly OutlineNode[];
  depth: number;
  maxOutlineLevels: number;
  selectedNodeId: string | null;
  isCollapsed: (nodeId: string) => boolean;
  /** Whether the active run (if any) is still drafting this node — shows a spinner (issue #21). */
  isGenerating?: (node: OutlineNode) => boolean;
  actions: OutlineRowActions;
}

function reportError(error: unknown, fallback: string) {
  const problem = error instanceof ApiError ? error.problem : undefined;
  toast.error(problem?.detail ?? problem?.title ?? fallback);
}

function OutlineRowComponent({
  projectId,
  entry,
  flat,
  depth,
  maxOutlineLevels,
  selectedNodeId,
  isCollapsed,
  isGenerating,
  actions,
}: OutlineRowProps) {
  const { node, children } = entry;
  const hasChildren = children.length > 0;
  const collapsed = isCollapsed(node.id);
  const isSelected = selectedNodeId === node.id;
  const canAddChild = node.level < maxOutlineLevels;
  const generating = isGenerating?.(node) ?? false;
  const rowRef = useRef<HTMLDivElement>(null);
  const updateMutation = useUpdateOutlineNodeMutation(projectId, node.id);

  useEffect(() => {
    if (isSelected) rowRef.current?.focus();
  }, [isSelected]);

  const siblings = childrenOf(node.parentId, flat);
  const siblingIndex = siblings.findIndex((sibling) => sibling.id === node.id);
  const previousSibling = siblingIndex > 0 ? siblings[siblingIndex - 1] : undefined;
  const parent = node.parentId ? flat.find((item) => item.id === node.parentId) : undefined;
  const canIndent = previousSibling !== undefined && node.level < maxOutlineLevels;
  const canOutdent = parent !== undefined;

  function rename(title: string) {
    updateMutation.mutate(
      { title },
      { onError: (error) => reportError(error, 'Could not rename section') },
    );
  }

  function toggleLock() {
    updateMutation.mutate(
      { structureLocked: !node.structureLocked },
      { onError: (error) => reportError(error, 'Could not change lock state') },
    );
  }

  function move(direction: 'up' | 'down' | 'indent' | 'outdent') {
    const onError = (error: unknown) => reportError(error, 'Could not move section');
    if (direction === 'up' && siblingIndex > 0) {
      updateMutation.mutate({ orderIndex: siblingIndex - 1 }, { onError });
    } else if (direction === 'down' && siblingIndex < siblings.length - 1) {
      updateMutation.mutate({ orderIndex: siblingIndex + 1 }, { onError });
    } else if (direction === 'indent' && previousSibling) {
      const newSiblings = childrenOf(previousSibling.id, flat);
      updateMutation.mutate(
        { parentId: previousSibling.id, orderIndex: newSiblings.length },
        { onError },
      );
    } else if (direction === 'outdent' && parent) {
      updateMutation.mutate(
        { parentId: parent.parentId, orderIndex: parent.orderIndex + 1 },
        { onError },
      );
    }
  }

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={rowRef}
            role="treeitem"
            aria-selected={isSelected}
            tabIndex={isSelected ? 0 : -1}
            data-node-id={node.id}
            className={cn(
              'group flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-none',
              isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
            )}
            style={{ paddingLeft: `${depth * 16 + 6}px` }}
            onClick={() => actions.onSelect(node.id)}
            onKeyDown={(event) => {
              if (
                event.key === 'ArrowUp' ||
                event.key === 'ArrowDown' ||
                event.key === 'Enter' ||
                event.key === 'Delete'
              ) {
                event.preventDefault();
                actions.onKeyNavigate(node.id, event.key);
              }
            }}
          >
            {hasChildren ? (
              <button
                type="button"
                aria-label={collapsed ? 'Expand' : 'Collapse'}
                className="flex size-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  actions.onToggleCollapse(node.id);
                }}
              >
                {collapsed ? (
                  <ChevronRight className="size-3.5" />
                ) : (
                  <ChevronDown className="size-3.5" />
                )}
              </button>
            ) : (
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            )}

            <span className="shrink-0 font-mono text-[11px] font-semibold text-muted-foreground">
              {node.sectionNumber}
            </span>

            <InlineEdit
              value={node.title}
              onCommit={rename}
              className="min-w-0 flex-1 text-sm"
              aria-label={`Rename "${node.title}"`}
            />

            {!node.structureLocked ? (
              <HoverCard openDelay={150}>
                <HoverCardTrigger asChild>
                  <Lock className="size-3 shrink-0 text-muted-foreground" />
                </HoverCardTrigger>
                <HoverCardContent className="w-56 text-xs">
                  Unlocked — the CLI may split this section into more nodes on its next run.
                </HoverCardContent>
              </HoverCard>
            ) : null}

            <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
              {canAddChild ? (
                <button
                  type="button"
                  title="Add sub-section"
                  className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={(event) => {
                    event.stopPropagation();
                    actions.onAddChild(node.id);
                  }}
                >
                  <Plus className="size-3.5" />
                </button>
              ) : null}
              <button
                type="button"
                title="Properties"
                className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  actions.onOpenProperties(node.id);
                }}
              >
                <Settings2 className="size-3.5" />
              </button>
              <button
                type="button"
                title="Delete"
                className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                onClick={(event) => {
                  event.stopPropagation();
                  actions.onDelete(node);
                }}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>

            {generating ? (
              <Loader2
                className="size-3 shrink-0 animate-spin text-primary"
                aria-label="Generating"
              />
            ) : null}
            <StatusBadge status={node.status} className="ml-0.5 shrink-0" />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {canAddChild ? (
            <ContextMenuItem onSelect={() => actions.onAddChild(node.id)}>
              Add sub-section
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem onSelect={() => actions.onOpenProperties(node.id)}>
            Properties
          </ContextMenuItem>
          <ContextMenuItem onSelect={toggleLock}>
            {node.structureLocked ? 'Unlock structure' : 'Lock structure'}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={siblingIndex <= 0} onSelect={() => move('up')}>
            Move up
          </ContextMenuItem>
          <ContextMenuItem
            disabled={siblingIndex >= siblings.length - 1}
            onSelect={() => move('down')}
          >
            Move down
          </ContextMenuItem>
          <ContextMenuItem disabled={!canOutdent} onSelect={() => move('outdent')}>
            Outdent
          </ContextMenuItem>
          <ContextMenuItem disabled={!canIndent} onSelect={() => move('indent')}>
            Indent
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => actions.onDelete(node)}>
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {hasChildren && !collapsed ? (
        <div>
          {children.map((child) => (
            <OutlineRow
              key={child.node.id}
              projectId={projectId}
              entry={child}
              flat={flat}
              depth={depth + 1}
              maxOutlineLevels={maxOutlineLevels}
              selectedNodeId={selectedNodeId}
              isCollapsed={isCollapsed}
              {...(isGenerating ? { isGenerating } : {})}
              actions={actions}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Memoized — a tree of up to hundreds of rows shouldn't re-render wholesale on every pane-level state change. */
export const OutlineRow = memo(OutlineRowComponent);
