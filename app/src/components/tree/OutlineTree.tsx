import React, { useState, useRef, useEffect } from 'react';
import { OutlineNode, NodeStatus } from '../../types';
import { DeleteNodeModal } from '../modals/DeleteNodeModal';
import { 
  Folder, 
  FileText, 
  ChevronRight, 
  ChevronDown, 
  Plus, 
  Sparkles, 
  CheckCircle2, 
  Clock, 
  AlertCircle, 
  Circle,
  Layers, 
  PanelLeftClose,
  Trash2,
  Edit3,
  Play,
  Sigma,
  BookOpen,
  Check,
  X
} from 'lucide-react';

interface OutlineTreeProps {
  nodes: OutlineNode[];
  selectedNodeId: string | null;
  onSelectNode: (node: OutlineNode) => void;
  onAddChildNode: (parentNodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onRenameNode?: (nodeId: string, newTitle: string) => void;
  onGenerateNode: (node: OutlineNode) => void;
  onTriggerNodeGeneration?: (promptModifier?: string) => void;
  isStreaming: boolean;
  maxLevels?: number;
  onToggleClose?: () => void;
}

interface StatusIconProps {
  node: OutlineNode;
}

const StatusIconWithPopover: React.FC<StatusIconProps> = ({ node }) => {
  const [showPopover, setShowPopover] = useState(false);
  const [placement, setPlacement] = useState<'top' | 'bottom'>('bottom');
  const buttonRef = useRef<HTMLDivElement | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleMouseEnter = () => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      // Default to opening downward. Only flip upward if near the very bottom of the screen
      if (rect.bottom > window.innerHeight - 160) {
        setPlacement('top');
      } else {
        setPlacement('bottom');
      }
    }
    timeoutRef.current = setTimeout(() => {
      setShowPopover(true);
    }, 100);
  };

  const handleMouseLeave = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setShowPopover(false);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const getStatusDetails = (status: NodeStatus) => {
    switch (status) {
      case 'compiled':
        return {
          icon: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />,
          label: 'Compiled & Ready',
          description: 'Full section content is generated and validated.',
          color: 'text-emerald-400',
        };
      case 'drafting':
        return {
          icon: <Clock className="w-3.5 h-3.5 text-amber-500 animate-spin" />,
          label: 'Drafting in Progress',
          description: 'Autonomous generation engine is actively writing.',
          color: 'text-amber-400',
        };
      case 'review_ready':
        return {
          icon: <AlertCircle className="w-3.5 h-3.5 text-sky-500" />,
          label: 'Review Needed',
          description: 'Draft completed, waiting for peer review.',
          color: 'text-sky-400',
        };
      case 'not_started':
      default:
        return {
          icon: <Circle className="w-3.5 h-3.5 text-slate-300 hover:text-slate-400 transition-colors" />,
          label: 'Not Started',
          description: 'Empty section outline. Ready for authoring or generation.',
          color: 'text-slate-400',
        };
    }
  };

  const details = getStatusDetails(node.status);

  return (
    <div 
      ref={buttonRef}
      className="relative flex items-center justify-center p-0.5 rounded hover:bg-slate-100 transition-colors cursor-help flex-shrink-0"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={(e) => e.stopPropagation()}
    >
      {details.icon}

      {showPopover && (
        <div className={`absolute right-0 ${placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'} z-[100] w-56 p-2.5 bg-slate-900 text-white rounded-lg shadow-2xl border border-slate-700/90 text-[11px] font-sans pointer-events-none animate-in fade-in zoom-in-95 duration-100`}>
          <div className="flex items-center justify-between gap-2 pb-1 mb-1 border-b border-slate-800">
            <span className={`font-semibold ${details.color}`}>{details.label}</span>
            <span className="text-[10px] font-mono text-slate-400">§{node.sectionNumber}</span>
          </div>
          <p className="text-slate-300 text-[10px] leading-relaxed mb-1.5">
            {details.description}
          </p>
          <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono pt-1 border-t border-slate-800/80">
            <span>Target: ~{node.targetPages}p</span>
            <span>Lvl {node.level}</span>
          </div>
        </div>
      )}
    </div>
  );
};

export const OutlineTree: React.FC<OutlineTreeProps> = ({
  nodes,
  selectedNodeId,
  onSelectNode,
  onAddChildNode,
  onDeleteNode,
  onRenameNode,
  onGenerateNode,
  onTriggerNodeGeneration,
  isStreaming,
  maxLevels = 3,
  onToggleClose,
}) => {
  const [collapsedNodes, setCollapsedNodes] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: OutlineNode } | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState<string>('');
  const [nodeToDelete, setNodeToDelete] = useState<OutlineNode | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);

  // Close context menu on outside click or scroll or escape
  useEffect(() => {
    const handleClickOutside = () => setContextMenu(null);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
        setEditingNodeId(null);
      }
    };

    if (contextMenu) {
      window.addEventListener('click', handleClickOutside);
      window.addEventListener('contextmenu', handleClickOutside);
      window.addEventListener('scroll', handleClickOutside, true);
      window.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      window.removeEventListener('click', handleClickOutside);
      window.removeEventListener('contextmenu', handleClickOutside);
      window.removeEventListener('scroll', handleClickOutside, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenu]);

  // Focus input when editing starts
  useEffect(() => {
    if (editingNodeId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingNodeId]);

  const toggleCollapse = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCollapsedNodes((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleContextMenu = (e: React.MouseEvent, node: OutlineNode) => {
    e.preventDefault();
    e.stopPropagation();
    onSelectNode(node);

    // Calculate clamped coordinates so menu stays inside viewport
    const menuWidth = 230;
    const menuHeight = 310;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8);

    setContextMenu({ x, y, node });
  };

  const startRename = (node: OutlineNode) => {
    setEditingNodeId(node.id);
    setEditTitle(node.title);
    setContextMenu(null);
  };

  const commitRename = (nodeId: string) => {
    if (editTitle.trim() && onRenameNode) {
      onRenameNode(nodeId, editTitle.trim());
    }
    setEditingNodeId(null);
  };

  const cancelRename = () => {
    setEditingNodeId(null);
  };

  const handleTriggerAction = (node: OutlineNode, promptModifier: string) => {
    onSelectNode(node);
    setContextMenu(null);
    if (onTriggerNodeGeneration) {
      onTriggerNodeGeneration(promptModifier);
    } else {
      onGenerateNode(node);
    }
  };

  const renderNode = (node: OutlineNode, depth = 0) => {
    const isSelected = selectedNodeId === node.id;
    const hasChildren = node.children && node.children.length > 0;
    const isCollapsed = !!collapsedNodes[node.id];
    const isEditing = editingNodeId === node.id;

    return (
      <div key={node.id} className="select-none">
        <div
          onClick={() => !isEditing && onSelectNode(node)}
          onContextMenu={(e) => handleContextMenu(e, node)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            startRename(node);
          }}
          className={`group relative hover:z-30 flex items-center justify-between gap-1.5 px-1.5 py-1.5 rounded-lg text-xs cursor-pointer transition-all ${
            isSelected
              ? 'bg-indigo-50/80 text-indigo-900 border border-indigo-200 shadow-2xs font-medium'
              : 'text-slate-700 hover:bg-slate-50 hover:text-slate-900 border border-transparent'
          }`}
          style={{ paddingLeft: `${Math.max(4, depth * 8 + 4)}px` }}
        >
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            {/* Collapse toggle if has children */}
            {hasChildren ? (
              <button
                type="button"
                onClick={(e) => toggleCollapse(node.id, e)}
                className="w-3.5 h-3.5 flex items-center justify-center text-slate-400 hover:text-slate-700 transition-colors flex-shrink-0"
              >
                {isCollapsed ? (
                  <ChevronRight className="w-3 h-3" />
                ) : (
                  <ChevronDown className="w-3 h-3" />
                )}
              </button>
            ) : (
              <span className="w-3.5 h-3.5 flex items-center justify-center text-slate-400 flex-shrink-0">
                <FileText className="w-3 h-3 text-slate-400" />
              </span>
            )}

            {/* Section Index */}
            <span className="font-mono text-[11px] text-slate-500 font-bold flex-shrink-0">
              {node.sectionNumber}
            </span>

            {/* Title / Inline Rename Input */}
            {isEditing ? (
              <div 
                className="flex items-center gap-1 flex-1 min-w-0" 
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  ref={editInputRef}
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitRename(node.id);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelRename();
                    }
                  }}
                  onBlur={() => commitRename(node.id)}
                  className="w-full px-1.5 py-0.5 bg-white border border-indigo-500 rounded text-xs font-semibold text-slate-900 focus:outline-none focus:ring-1 focus:ring-indigo-500 shadow-inner"
                />
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commitRename(node.id);
                  }}
                  className="p-0.5 text-emerald-600 hover:bg-emerald-50 rounded"
                >
                  <Check className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    cancelRename();
                  }}
                  className="p-0.5 text-slate-400 hover:bg-slate-100 rounded"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <span 
                className="truncate flex-1"
                title="Double-click to rename or right-click for actions"
              >
                {node.title}
              </span>
            )}
          </div>

          {/* Right Action Buttons & Status Icon (Order on hover: Add -> Generate -> Status Icon) */}
          {!isEditing && (
            <div className="flex items-center gap-1 flex-shrink-0">
              {/* Hover Actions: 1. Add, 2. Generate */}
              <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity">
                {node.level < maxLevels && (
                  <button
                    type="button"
                    title={`Add Sub-section (Level ${node.level + 1})`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddChildNode(node.id);
                    }}
                    className="p-1 hover:bg-slate-200/80 rounded text-slate-500 hover:text-slate-900 transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                )}

                <button
                  type="button"
                  title="Generate with Multi-Agent"
                  disabled={isStreaming}
                  onClick={(e) => {
                    e.stopPropagation();
                    onGenerateNode(node);
                  }}
                  className="p-1 hover:bg-indigo-600 rounded text-indigo-600 hover:text-white transition-colors"
                >
                  <Sparkles className="w-3 h-3" />
                </button>

                <button
                  type="button"
                  title={`Delete ${node.level === 1 ? 'Chapter' : 'Section'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setNodeToDelete(node);
                  }}
                  className="p-1 hover:bg-rose-100 rounded text-slate-400 hover:text-rose-600 transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>

              {/* 3. Status Icon on the right side of the pane with 100ms delayed popover */}
              <StatusIconWithPopover node={node} />
            </div>
          )}
        </div>

        {/* Recursive Children Rendering */}
        {hasChildren && !isCollapsed && (
          <div className="mt-0.5 space-y-0.5 border-l border-slate-200/80 ml-1.5 pl-1">
            {node.children!.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col bg-white border-r border-slate-200 relative">
      {/* Pane Header - Compact */}
      <div className="h-11 px-3 border-b border-slate-200 flex items-center justify-between bg-[#F8FAFC]">
        <div className="flex items-center gap-1.5">
          <Folder className="w-3.5 h-3.5 text-indigo-600" />
          <h3 className="text-[11px] font-bold text-slate-700 uppercase tracking-wider">
            Outline
          </h3>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => onAddChildNode('root')}
            className="flex items-center gap-1 text-[11px] font-semibold text-indigo-700 hover:text-indigo-800 bg-white hover:bg-indigo-50 border border-slate-200 hover:border-indigo-200 px-2 py-0.5 rounded-md transition-colors shadow-2xs"
          >
            <Plus className="w-3 h-3 text-indigo-600" />
            <span>Add Chapter</span>
          </button>

          {onToggleClose && (
            <button
              onClick={onToggleClose}
              title="Close Outline Pane"
              className="p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 transition-colors ml-0.5"
            >
              <PanelLeftClose className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Node Tree List */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5 custom-scrollbar">
        {nodes.length === 0 ? (
          <div className="p-6 text-center text-slate-400 text-xs">
            No sections in outline. Click "Add Chapter" or generate with AI.
          </div>
        ) : (
          nodes.map((node) => renderNode(node, 0))
        )}
      </div>

      {/* Tree Footer: Summary Stats */}
      <div className="h-8 px-3 border-t border-slate-200 bg-[#F8FAFC] text-[11px] text-slate-500 flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-medium">
          <Layers className="w-3 h-3 text-indigo-600" />
          <span>{nodes.length} Chapters</span>
        </div>
        <div className="flex items-center gap-1 font-mono font-semibold text-indigo-600 text-[10px]">
          <span>Structured Tree</span>
        </div>
      </div>

      {/* Right-Click Context Submenu */}
      {contextMenu && (
        <div
          className="fixed z-[200] w-56 bg-white border border-slate-200 rounded-xl shadow-2xl py-1 text-xs text-slate-700 font-sans animate-in fade-in zoom-in-95 duration-100 select-none overflow-hidden"
          style={{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Section 1: Quick Actions from Copilot */}
          <div className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Copilot Quick Actions
          </div>

          <button
            disabled={isStreaming}
            onClick={() => handleTriggerAction(contextMenu.node, 'Draft full section with comprehensive theoretical narrative and lemmas.')}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-indigo-50 hover:text-indigo-700 transition-colors disabled:opacity-50 font-medium"
          >
            <Play className="w-3.5 h-3.5 text-indigo-600 fill-indigo-600" />
            <span>Draft Section</span>
          </button>

          <button
            disabled={isStreaming}
            onClick={() => handleTriggerAction(contextMenu.node, 'Formalize equations with rigorous stabilizer math & theorem bounds')}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-indigo-50 hover:text-indigo-700 transition-colors disabled:opacity-50 font-medium"
          >
            <Sigma className="w-3.5 h-3.5 text-indigo-600" />
            <span>Expand Proofs</span>
          </button>

          <button
            disabled={isStreaming}
            onClick={() => handleTriggerAction(contextMenu.node, 'Insert intuitive pedagogical example and step-by-step exercise')}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-indigo-50 hover:text-indigo-700 transition-colors disabled:opacity-50 font-medium"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-500" />
            <span>Add Examples</span>
          </button>

          <button
            disabled={isStreaming}
            onClick={() => handleTriggerAction(contextMenu.node, 'Integrate literature citations and historical background from primary sources')}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-indigo-50 hover:text-indigo-700 transition-colors disabled:opacity-50 font-medium"
          >
            <BookOpen className="w-3.5 h-3.5 text-sky-600" />
            <span>Cite Sources</span>
          </button>

          <div className="h-px bg-slate-100 my-1" />

          {/* Section 2: Structure Actions (Rename & Add Child) */}
          <button
            onClick={() => startRename(contextMenu.node)}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-slate-50 hover:text-slate-900 transition-colors font-medium"
          >
            <Edit3 className="w-3.5 h-3.5 text-slate-500" />
            <span>Rename Section</span>
          </button>

          {contextMenu.node.level < maxLevels && (
            <button
              onClick={() => {
                onAddChildNode(contextMenu.node.id);
                setContextMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-slate-50 hover:text-slate-900 transition-colors font-medium"
            >
              <Plus className="w-3.5 h-3.5 text-slate-500" />
              <span>Add Sub-section</span>
            </button>
          )}

          <div className="h-px bg-slate-100 my-1" />

          {/* Section 3: Delete Action */}
          <button
            onClick={() => {
              setNodeToDelete(contextMenu.node);
              setContextMenu(null);
            }}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 text-rose-600 hover:bg-rose-50 hover:text-rose-700 transition-colors font-medium"
          >
            <Trash2 className="w-3.5 h-3.5 text-rose-500" />
            <span>Delete Section</span>
          </button>
        </div>
      )}

      {/* Confirmation Modal for Outline Section Deletion */}
      <DeleteNodeModal
        isOpen={Boolean(nodeToDelete)}
        node={nodeToDelete}
        onClose={() => setNodeToDelete(null)}
        onConfirmDelete={(nodeId) => {
          onDeleteNode(nodeId);
          setNodeToDelete(null);
        }}
      />
    </div>
  );
};

