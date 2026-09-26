import { memo, useEffect, useRef } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Database,
  FileText,
  Loader2,
  Lock,
  LockOpen,
  Plus,
  Settings2,
  Split,
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
import {
  ADD_UNDER_LOCKED_MESSAGE,
  CONTENT_LOCKED_BADGE_LABEL,
  contentLockDisabledReason,
  contentLockToggleLabel,
} from '@/features/outline/content-lock';
import { childrenOf, type OutlineTree } from '@/features/outline/model';
import { inheritedSourceScope, resolveSourceScope } from '@/features/outline/source-scope';
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
  /**
   * Active outline filter text, if any — while set, the title renders as a read-only span with
   * the matched substring highlighted instead of the editable `InlineEdit` (issue #115).
   */
  highlightQuery?: string;
  /**
   * True while the project has a queued/running run — the backend rejects every structural
   * write (create/delete/move) with 409 for as long as that's true (`OutlineService.
   * _reject_if_run_active`, issue #74), so add/delete/move/indent/outdent are disabled here to
   * match. Rename, lock toggle, and Properties stay enabled since the backend still allows them.
   */
  structuralEditsDisabled: boolean;
  actions: OutlineRowActions;
}

/**
 * Shared with `OutlinePane` (toolbar/empty-state controls, banner) so the wording is consistent
 * everywhere the outline's structural edits are disabled for the same reason.
 */
export const STRUCTURE_LOCKED_MESSAGE =
  "A run is active — the outline's structure can't be changed until it finishes or is cancelled.";

/**
 * Move/indent/outdent reorder a node relative to its siblings in `flat` — while a filter is
 * active, some of those siblings are pruned out of the visible tree, so reordering against them
 * would silently happen relative to a hidden node. Clearing the filter first keeps the intended
 * order in view.
 */
const FILTER_ACTIVE_MOVE_MESSAGE = 'Clear the outline filter to reorder sections.';

function reportError(error: unknown, fallback: string) {
  const problem = error instanceof ApiError ? error.problem : undefined;
  toast.error(problem?.detail ?? problem?.title ?? fallback);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Wraps the first case-insensitive match of (already-trimmed) `query` in `text` with `<mark>`, or
 * returns `text` unchanged if there's no match. Matches with a regex against the original-case
 * `text` directly (rather than comparing lowercased copies) so the returned slice indices can't
 * desync from a case-fold that changes string length (e.g. Turkish İ under `.toLowerCase()`).
 */
function highlightMatch(text: string, query: string): React.ReactNode {
  const match = new RegExp(escapeRegExp(query), 'i').exec(text);
  if (!match) return text;
  const start = match.index;
  const end = start + match[0].length;
  return (
    <>
      {text.slice(0, start)}
      <mark className="rounded-sm bg-primary/25 text-inherit">{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
}

/**
 * The compact source-scope marker after a row's title (issue #138): a solid pill for the node's
 * own selection, a dashed one for a selection it inherits, "All" for an explicit all-sources
 * override under a scoped ancestor, and nothing when retrieval is unrestricted.
 */
function SourceScopePill({ node, flat }: { node: OutlineNode; flat: readonly OutlineNode[] }) {
  const sectionOf = (nodeId: string | null) =>
    flat.find((item) => item.id === nodeId)?.sectionNumber ?? '';
  let variant: 'own' | 'inherited' | 'all';
  let count = 0;
  let label: string;
  if (node.sourceScope === 'selected' && node.sourceIds.length > 0) {
    variant = 'own';
    count = node.sourceIds.length;
    label = `${count} ${count === 1 ? 'source' : 'sources'} selected on this node`;
  } else if (node.sourceScope === 'inherit') {
    const effective = resolveSourceScope(node.id, flat);
    if (effective.kind !== 'selected') return null;
    variant = 'inherited';
    count = effective.sourceIds.length;
    label = `${count} ${count === 1 ? 'source' : 'sources'} inherited from §${sectionOf(effective.fromNodeId)}`;
  } else if (node.sourceScope === 'all') {
    const inherited = inheritedSourceScope(node.id, flat);
    if (inherited.kind !== 'selected') return null;
    variant = 'all';
    label = `Uses all project sources instead of §${sectionOf(inherited.fromNodeId)}'s selection`;
  } else {
    return null;
  }

  return (
    <span
      title={label}
      data-scope-pill={variant}
      className={cn(
        'inline-flex h-4 shrink-0 items-center gap-0.5 rounded-full border px-1.5 font-mono text-[10px] leading-none font-semibold',
        variant === 'own' && 'border-primary/30 bg-primary/10 text-primary',
        variant === 'inherited' && 'border-dashed border-muted-foreground/40 text-muted-foreground',
        variant === 'all' && 'border-border text-muted-foreground',
      )}
    >
      <span className="sr-only">{label}</span>
      <span aria-hidden="true" className="inline-flex items-center gap-0.5">
        {variant === 'own' ? <Database className="size-2.5" /> : null}
        {variant === 'inherited' ? <CornerDownRight className="size-2.5" /> : null}
        {variant === 'all' ? 'All' : count}
      </span>
    </span>
  );
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
  highlightQuery,
  structuralEditsDisabled,
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
  const moveDisabledByFilter = Boolean(highlightQuery);
  const moveDisabledMessage = structuralEditsDisabled
    ? STRUCTURE_LOCKED_MESSAGE
    : moveDisabledByFilter
      ? FILTER_ACTIVE_MOVE_MESSAGE
      : undefined;
  // Content lock (issue #113) - against `flat`, not `entry.children`: an active filter prunes
  // children out of the visible tree, and a parent must never look lockable because of that.
  const contentLockDisabledMessage = contentLockDisabledReason(node, flat);
  const contentLockLabel = contentLockToggleLabel(node);
  // The API 409s a create/move under a content-locked leaf (a lock means nothing on a parent).
  const addChildDisabledMessage = structuralEditsDisabled
    ? STRUCTURE_LOCKED_MESSAGE
    : node.contentLocked
      ? ADD_UNDER_LOCKED_MESSAGE
      : undefined;

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

  function toggleContentLock() {
    updateMutation.mutate(
      { contentLocked: !node.contentLocked },
      { onError: (error) => reportError(error, 'Could not change the content lock') },
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
              'group relative flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-none',
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
              {highlightQuery
                ? highlightMatch(node.sectionNumber, highlightQuery)
                : node.sectionNumber}
            </span>

            {highlightQuery ? (
              // Mirrors `InlineEdit`'s non-editing display span (role/tabIndex/title) so filtering
              // doesn't regress hover-tooltip or keyboard-focus behavior — just swaps in the
              // highlighted text and drops the double-click-to-rename affordance.
              <span
                role="textbox"
                tabIndex={0}
                aria-label={`Rename "${node.title}"`}
                title={`${node.sectionNumber} ${node.title}`}
                className="min-w-0 flex-1 cursor-text truncate text-sm"
              >
                {highlightMatch(node.title, highlightQuery)}
              </span>
            ) : (
              <InlineEdit
                value={node.title}
                onCommit={rename}
                className="min-w-0 flex-1 text-sm"
                aria-label={`Rename "${node.title}"`}
                title={`${node.sectionNumber} ${node.title}`}
              />
            )}

            <SourceScopePill node={node} flat={flat} />

            {node.contentLocked ? (
              <span
                title={CONTENT_LOCKED_BADGE_LABEL}
                data-content-locked=""
                className="inline-flex h-4 shrink-0 items-center rounded-full border border-primary/30 bg-primary/10 px-1.5 text-primary"
              >
                <span className="sr-only">{CONTENT_LOCKED_BADGE_LABEL}</span>
                <Lock aria-hidden="true" className="size-2.5" />
              </span>
            ) : null}

            {!node.structureLocked ? (
              <HoverCard openDelay={150}>
                <HoverCardTrigger asChild>
                  {/* Not a lock icon: this is about the CLI splitting the node, and the row's
                      lock glyphs now mean "content locked" (issue #113). */}
                  <Split
                    aria-label="Structure unlocked"
                    className="size-3 shrink-0 text-muted-foreground"
                  />
                </HoverCardTrigger>
                <HoverCardContent className="w-60 text-xs">
                  Structure unlocked — the CLI may split this section into more nodes on its next
                  run. This is unrelated to locking the section's content.
                </HoverCardContent>
              </HoverCard>
            ) : null}

            <div
              className={cn(
                // `opacity-0` alone still leaves the buttons hit-testable and overlapping the
                // title — `pointer-events-none` keeps them inert until actually shown.
                //
                // The fill is solid (not `/50`, and not conditional on `isSelected`): this sits
                // directly on top of the spinner/`StatusBadge` at the row's right edge (see their
                // `group-hover:opacity-0` below), and a translucent or row-bg-matched fill let
                // that trailing content visibly bleed through behind the icons.
                //
                // `z-10` is load-bearing: fading the spinner/`StatusBadge` to `opacity-0` gives
                // them a stacking context, and a stacking context is painted in the same layer
                // as this positioned group, in DOM order — they come later, so without an explicit
                // z-index the invisible badge sat on top and swallowed every click on the buttons.
                'pointer-events-none absolute top-1/2 right-1 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded bg-accent px-0.5 opacity-0 shadow-sm transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100',
              )}
            >
              {canAddChild ? (
                <button
                  type="button"
                  title={addChildDisabledMessage ?? 'Add sub-section'}
                  aria-label="Add sub-section"
                  disabled={Boolean(addChildDisabledMessage)}
                  className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
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
                // No `disabled:pointer-events-none` here, unlike its siblings: the title *is* the
                // explanation of why it's disabled, and it can't show if hover never reaches it.
                title={contentLockDisabledMessage ?? contentLockLabel}
                aria-label={contentLockLabel}
                aria-pressed={node.contentLocked}
                disabled={Boolean(contentLockDisabledMessage)}
                className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleContentLock();
                }}
              >
                {node.contentLocked ? (
                  <LockOpen className="size-3.5" />
                ) : (
                  <Lock className="size-3.5" />
                )}
              </button>
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
                title={structuralEditsDisabled ? STRUCTURE_LOCKED_MESSAGE : 'Delete'}
                disabled={structuralEditsDisabled}
                className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
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
                className="size-3 shrink-0 animate-spin text-primary transition-opacity group-focus-within:opacity-0 group-hover:opacity-0"
                aria-label="Generating"
              />
            ) : null}
            <StatusBadge
              status={node.status}
              className="ml-0.5 shrink-0 transition-opacity group-focus-within:opacity-0 group-hover:opacity-0"
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {canAddChild ? (
            <ContextMenuItem
              disabled={Boolean(addChildDisabledMessage)}
              title={addChildDisabledMessage}
              onSelect={() => actions.onAddChild(node.id)}
            >
              Add sub-section
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem onSelect={() => actions.onOpenProperties(node.id)}>
            Properties
          </ContextMenuItem>
          <ContextMenuItem
            disabled={Boolean(contentLockDisabledMessage)}
            title={contentLockDisabledMessage}
            onSelect={toggleContentLock}
          >
            {contentLockLabel}
          </ContextMenuItem>
          <ContextMenuItem onSelect={toggleLock}>
            {node.structureLocked
              ? 'Unlock structure (allow the CLI to split it)'
              : 'Lock structure (never split it)'}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={siblingIndex <= 0 || structuralEditsDisabled || moveDisabledByFilter}
            title={moveDisabledMessage}
            onSelect={() => move('up')}
          >
            Move up
          </ContextMenuItem>
          <ContextMenuItem
            disabled={
              siblingIndex >= siblings.length - 1 || structuralEditsDisabled || moveDisabledByFilter
            }
            title={moveDisabledMessage}
            onSelect={() => move('down')}
          >
            Move down
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!canOutdent || structuralEditsDisabled || moveDisabledByFilter}
            title={moveDisabledMessage}
            onSelect={() => move('outdent')}
          >
            Outdent
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!canIndent || structuralEditsDisabled || moveDisabledByFilter}
            title={moveDisabledMessage}
            onSelect={() => move('indent')}
          >
            Indent
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            disabled={structuralEditsDisabled}
            title={structuralEditsDisabled ? STRUCTURE_LOCKED_MESSAGE : undefined}
            onSelect={() => actions.onDelete(node)}
          >
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
              {...(highlightQuery ? { highlightQuery } : {})}
              structuralEditsDisabled={structuralEditsDisabled}
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
