import React, { useState } from 'react';
import { OutlineNode, AgentStreamLog } from '../../types';
import { StageEditor } from '../editor/StageEditor';
import { AgentStreamDrawer } from '../agent/AgentStreamDrawer';
import { 
  ZoomIn, 
  ZoomOut, 
  Maximize2, 
  Sparkles, 
  Layers, 
  CheckCircle2, 
  Clock, 
  AlertCircle, 
  BookOpen, 
  Sigma, 
  ArrowRight,
  ChevronRight,
  Filter,
  X,
  Play,
  Cpu
} from 'lucide-react';

interface CanvasGraphViewProps {
  nodes: OutlineNode[];
  selectedNode: OutlineNode | null;
  onSelectNode: (node: OutlineNode) => void;
  onAddChildNode: (parentNodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onGenerateNode: (node: OutlineNode) => void;
  onUpdateContent: (nodeId: string, markdown: string) => void;
  onTriggerNodeGeneration: (promptModifier?: string) => void;
  onUpdateNodeMathLevel: (mathLevel: OutlineNode['mathLevel']) => void;
  onUpdateNodeEquationDensity: (density: number) => void;
  isStreaming: boolean;
  logs: AgentStreamLog[];
  tokenBuffer: string;
  thoughtTrace: string[];
}

export const CanvasGraphView: React.FC<CanvasGraphViewProps> = ({
  nodes,
  selectedNode,
  onSelectNode,
  onAddChildNode,
  onGenerateNode,
  onUpdateContent,
  onTriggerNodeGeneration,
  onUpdateNodeMathLevel,
  onUpdateNodeEquationDensity,
  isStreaming,
  logs,
  tokenBuffer,
  thoughtTrace,
}) => {
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [drawerOpen, setDrawerOpen] = useState<boolean>(true);

  // Flatten nodes for the DAG grid representation
  const getAllNodesWithHierarchy = (nodeList: OutlineNode[], parentTitle?: string): Array<{ node: OutlineNode; parentTitle?: string }> => {
    const list: Array<{ node: OutlineNode; parentTitle?: string }> = [];
    nodeList.forEach((n) => {
      list.push({ node: n, parentTitle });
      if (n.children && n.children.length > 0) {
        list.push(...getAllNodesWithHierarchy(n.children, n.title));
      }
    });
    return list;
  };

  const allItems = getAllNodesWithHierarchy(nodes);

  const getStatusColor = (status: OutlineNode['status']) => {
    switch (status) {
      case 'compiled':
        return 'border-emerald-200 bg-emerald-50/60 text-emerald-800';
      case 'drafting':
        return 'border-amber-200 bg-amber-50/60 text-amber-800';
      case 'review_ready':
        return 'border-sky-200 bg-sky-50/60 text-sky-800';
      default:
        return 'border-slate-200 bg-white text-slate-700';
    }
  };

  return (
    <div className="flex-1 flex overflow-hidden h-[calc(100vh-136px)] relative bg-[#F8FAFC]">
      {/* Background Dot-Grid Canvas */}
      <div 
        className="flex-1 overflow-auto p-6 md:p-8 relative custom-scrollbar"
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(99, 102, 241, 0.15) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
      >
        {/* Canvas HUD Controls Bar */}
        <div className="sticky top-0 z-20 flex items-center justify-between gap-3 mb-6 bg-white/95 border border-slate-200 rounded-xl p-2.5 backdrop-blur-md shadow-sm max-w-4xl mx-auto">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-indigo-600 animate-pulse"></span>
            <span className="text-xs font-bold text-slate-900 uppercase tracking-widest">
              Topological DAG Graph
            </span>
            <span className="text-[11px] font-mono font-medium text-slate-500">
              ({allItems.length} Total Nodes)
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Filter */}
            <div className="flex items-center gap-1 text-xs bg-[#F8FAFC] px-2.5 py-1 rounded-lg border border-slate-200">
              <Filter className="w-3 h-3 text-slate-500" />
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="bg-transparent text-slate-700 text-xs font-medium focus:outline-none cursor-pointer"
              >
                <option value="all">All Statuses</option>
                <option value="compiled">Compiled</option>
                <option value="drafting">Drafting</option>
                <option value="review_ready">Review</option>
                <option value="not_started">Empty</option>
              </select>
            </div>

            {/* Zoom */}
            <div className="flex items-center gap-1 bg-[#F8FAFC] p-1 rounded-lg border border-slate-200 text-xs">
              <button
                onClick={() => setZoomLevel((z) => Math.max(70, z - 10))}
                className="p-1 hover:bg-slate-200/70 rounded text-slate-500 hover:text-slate-900 transition-colors"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <span className="font-mono text-[11px] px-1.5 font-bold text-slate-700">{zoomLevel}%</span>
              <button
                onClick={() => setZoomLevel((z) => Math.min(130, z + 10))}
                className="p-1 hover:bg-slate-200/70 rounded text-slate-500 hover:text-slate-900 transition-colors"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>

            {selectedNode && (
              <button
                onClick={() => setDrawerOpen(!drawerOpen)}
                className="px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold flex items-center gap-1 shadow-xs transition-colors"
              >
                <span>{drawerOpen ? 'Hide Focus Desk' : 'Open Focus Desk'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Graph Cluster Nodes */}
        <div 
          className="max-w-5xl mx-auto space-y-8 transition-transform origin-top"
          style={{ transform: `scale(${zoomLevel / 100})` }}
        >
          {nodes.map((chapterNode, chIdx) => {
            const hasChildren = chapterNode.children && chapterNode.children.length > 0;

            return (
              <div key={chapterNode.id} className="space-y-4">
                {/* Chapter Card (Parent Node) */}
                <div
                  onClick={() => {
                    onSelectNode(chapterNode);
                    setDrawerOpen(true);
                  }}
                  className={`p-5 rounded-2xl border-2 transition-all cursor-pointer relative group shadow-sm bg-white ${
                    selectedNode?.id === chapterNode.id
                      ? 'border-indigo-600 ring-4 ring-indigo-500/10'
                      : `${getStatusColor(chapterNode.status)} hover:border-slate-300`
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3.5">
                      <div className="w-11 h-11 rounded-xl bg-indigo-600 text-white font-serif font-bold text-lg flex items-center justify-center shadow-xs flex-shrink-0">
                        {chapterNode.sectionNumber}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-mono font-bold text-indigo-600 uppercase tracking-widest">
                            Chapter {chapterNode.sectionNumber} • Root Concept
                          </span>
                          <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200">
                            ~{chapterNode.targetPages} Pages
                          </span>
                        </div>
                        <h3 className="text-base font-bold font-serif text-slate-900 mt-0.5">
                          {chapterNode.title}
                        </h3>
                        {chapterNode.subPrompt && (
                          <p className="text-xs text-slate-500 italic mt-1 max-w-xl">
                            "{chapterNode.subPrompt}"
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={isStreaming}
                        onClick={(e) => {
                          e.stopPropagation();
                          onGenerateNode(chapterNode);
                        }}
                        className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold flex items-center gap-1.5 shadow-xs transition-colors"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Synthesize</span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Recursive Child Sections (Sub-DAG Branches) */}
                {hasChildren && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pl-6 border-l-2 border-dashed border-indigo-200 ml-5">
                    {chapterNode.children!.map((secNode) => {
                      const isSecSelected = selectedNode?.id === secNode.id;

                      return (
                        <div
                          key={secNode.id}
                          onClick={() => {
                            onSelectNode(secNode);
                            setDrawerOpen(true);
                          }}
                          className={`p-3.5 rounded-xl border transition-all cursor-pointer group shadow-2xs ${
                            isSecSelected
                              ? 'border-indigo-600 ring-2 ring-indigo-500/10 bg-indigo-50/30 shadow-xs'
                              : `${getStatusColor(secNode.status)} hover:border-slate-300`
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2 mb-1.5">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-200">
                                § {secNode.sectionNumber}
                              </span>
                              <span className="text-[10px] font-mono text-slate-500">
                                ~{secNode.targetPages}p • {secNode.wordBudget.toLocaleString()}w
                              </span>
                            </div>

                            <span className="text-[10px] font-mono font-medium capitalize text-slate-500">
                              {secNode.status.replace('_', ' ')}
                            </span>
                          </div>

                          <h4 className="text-xs font-bold text-slate-800 line-clamp-1 group-hover:text-indigo-600 transition-colors">
                            {secNode.title}
                          </h4>

                          <div className="mt-2.5 pt-2 border-t border-slate-200/80 flex items-center justify-between text-[11px] text-slate-500">
                            <span className="flex items-center gap-1 font-medium">
                              <Sigma className="w-3 h-3 text-indigo-600" />
                              <span>Math Lvl {secNode.equationDensityLevel}/5</span>
                            </span>

                            <span className="flex items-center gap-1 text-indigo-600 font-semibold group-hover:translate-x-0.5 transition-transform">
                              <span>Open Desk</span>
                              <ArrowRight className="w-3 h-3" />
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Slide-over Focus Studio Drawer on Selected Node */}
      {selectedNode && drawerOpen && (
        <div className="w-full md:w-[600px] xl:w-[700px] h-full bg-white border-l border-slate-200 shadow-xl z-30 flex flex-col transition-all">
          <div className="p-3 bg-[#F8FAFC] border-b border-slate-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-slate-800">
                Focus Desk: §{selectedNode.sectionNumber} {selectedNode.title}
              </span>
            </div>
            <button
              onClick={() => setDrawerOpen(false)}
              className="p-1 hover:bg-slate-200/70 text-slate-400 hover:text-slate-800 rounded transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-hidden">
            <StageEditor
              selectedNode={selectedNode}
              onUpdateContent={onUpdateContent}
              onTriggerContextualPrompt={onTriggerNodeGeneration}
              isStreaming={isStreaming}
            />
          </div>
        </div>
      )}
    </div>
  );
};
