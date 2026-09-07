import React, { useState } from 'react';
import { OutlineNode, AgentStreamLog, RAGCitation } from '../../types';
import { 
  Cpu, 
  Sparkles, 
  Terminal, 
  BookOpen, 
  Sliders, 
  CheckCircle2, 
  MessageSquare, 
  Sigma, 
  ChevronDown, 
  Layers, 
  FileCheck, 
  Send, 
  HelpCircle, 
  Play, 
  ListOrdered,
  PanelRightClose
} from 'lucide-react';

interface AgentStreamDrawerProps {
  selectedNode: OutlineNode | null;
  isStreaming: boolean;
  logs: AgentStreamLog[];
  tokenBuffer: string;
  thoughtTrace: string[];
  onTriggerNodeGeneration: (promptModifier?: string) => void;
  onUpdateNodeMathLevel: (mathLevel: OutlineNode['mathLevel']) => void;
  onUpdateNodeEquationDensity: (density: number) => void;
  onUpdateNodeBudget?: (targetPages: number, wordBudget: number) => void;
  onToggleClose?: () => void;
}

export const AgentStreamDrawer: React.FC<AgentStreamDrawerProps> = ({
  selectedNode,
  isStreaming,
  logs,
  tokenBuffer,
  thoughtTrace,
  onTriggerNodeGeneration,
  onUpdateNodeMathLevel,
  onUpdateNodeEquationDensity,
  onUpdateNodeBudget,
  onToggleClose,
}) => {
  const [activeTab, setActiveTab] = useState<'stream' | 'citations' | 'tuning'>('stream');
  const [customPrompt, setCustomPrompt] = useState('');
  const [showThoughts, setShowThoughts] = useState(false);
  const [showPipeline, setShowPipeline] = useState(false);

  if (!selectedNode) {
    return (
      <div className="h-full bg-white border-l border-slate-200 p-6 flex flex-col items-center justify-center text-center text-slate-400">
        <Cpu className="w-8 h-8 text-slate-300 mb-2 animate-pulse" />
        <p className="text-xs font-medium text-slate-500">Select a node from the outline tree to interact with AI Copilot.</p>
        {onToggleClose && (
          <button
            onClick={onToggleClose}
            className="mt-3 text-xs text-indigo-600 hover:text-indigo-800 font-semibold"
          >
            Close Copilot Pane
          </button>
        )}
      </div>
    );
  }

  const handleSendPrompt = () => {
    if (!customPrompt.trim() || isStreaming) return;
    onTriggerNodeGeneration(customPrompt);
    setCustomPrompt('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSendPrompt();
    }
  };

  const handleBudgetChange = (pages: number) => {
    const validPages = Math.max(1, Math.min(100, pages));
    if (onUpdateNodeBudget) {
      onUpdateNodeBudget(validPages, validPages * 350);
    }
  };

  return (
    <div className="h-full flex flex-col bg-white border-l border-slate-200">
      {/* Tab Switcher as Header without grey background & without redundant title */}
      <div className="h-11 px-2.5 border-b border-slate-200 flex items-center justify-between gap-1 bg-white">
        <div className="flex items-center gap-1 flex-1">
          <button
            onClick={() => setActiveTab('stream')}
            className={`py-1 px-2.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
              activeTab === 'stream'
                ? 'bg-indigo-50 text-indigo-700 border border-indigo-200/80 shadow-2xs font-bold'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
            <span>Copilot</span>
          </button>

          <button
            onClick={() => setActiveTab('citations')}
            className={`py-1 px-2.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
              activeTab === 'citations'
                ? 'bg-indigo-50 text-indigo-700 border border-indigo-200/80 shadow-2xs font-bold'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5 text-indigo-600" />
            <span>Citations ({selectedNode.ragCitations.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('tuning')}
            className={`py-1 px-2.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
              activeTab === 'tuning'
                ? 'bg-indigo-50 text-indigo-700 border border-indigo-200/80 shadow-2xs font-bold'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
            }`}
          >
            <Sliders className="w-3.5 h-3.5 text-indigo-600" />
            <span>Settings</span>
          </button>
        </div>

        {/* Close Button for Copilot Pane */}
        {onToggleClose && (
          <button
            onClick={onToggleClose}
            title="Close Copilot Pane"
            className="p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors flex-shrink-0"
          >
            <PanelRightClose className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Main Tab Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar">
        {activeTab === 'stream' && (
          <div className="space-y-3">
            {/* Clear Goal & Guidance Box */}
            <div className="p-3 rounded-xl bg-indigo-50/50 border border-indigo-100 space-y-2">
              <div className="flex items-center justify-between text-[11px] font-bold text-indigo-900">
                <span className="flex items-center gap-1">
                  <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
                  Quick Actions for §{selectedNode.sectionNumber}
                </span>
                <span className="text-[10px] font-mono text-indigo-600 font-semibold">1-Click</span>
              </div>
              <p className="text-xs text-slate-600 leading-snug">
                Instruct the multi-agent team to draft content, derive proofs, or add examples:
              </p>

              <div className="grid grid-cols-2 gap-1.5 pt-0.5">
                <button
                  type="button"
                  disabled={isStreaming}
                  onClick={() => onTriggerNodeGeneration('Draft full section with comprehensive theoretical narrative and lemmas.')}
                  className="py-1.5 px-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold flex items-center justify-center gap-1 transition-all shadow-2xs"
                >
                  <Play className="w-3 h-3 fill-current" />
                  <span>Draft Section</span>
                </button>

                <button
                  type="button"
                  disabled={isStreaming}
                  onClick={() => onTriggerNodeGeneration('Formalize equations with rigorous stabilizer math & theorem bounds')}
                  className="py-1.5 px-2 rounded-lg bg-white hover:bg-slate-50 border border-slate-200 text-indigo-700 text-xs font-semibold flex items-center justify-center gap-1 transition-all shadow-2xs"
                >
                  <Sigma className="w-3 h-3 text-indigo-600" />
                  <span>Expand Proofs</span>
                </button>

                <button
                  type="button"
                  disabled={isStreaming}
                  onClick={() => onTriggerNodeGeneration('Insert intuitive pedagogical example and step-by-step exercise')}
                  className="py-1.5 px-2 rounded-lg bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs font-semibold flex items-center justify-center gap-1 transition-all shadow-2xs"
                >
                  <Sparkles className="w-3 h-3 text-amber-500" />
                  <span>Add Examples</span>
                </button>

                <button
                  type="button"
                  disabled={isStreaming}
                  onClick={() => onTriggerNodeGeneration('Integrate literature citations and historical background from primary sources')}
                  className="py-1.5 px-2 rounded-lg bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs font-semibold flex items-center justify-center gap-1 transition-all shadow-2xs"
                >
                  <BookOpen className="w-3 h-3 text-sky-600" />
                  <span>Cite Sources</span>
                </button>
              </div>
            </div>

            {/* Multiline Chat Input (Minimum 6 lines) */}
            <div className="p-3 rounded-xl bg-white border border-slate-200 space-y-2 shadow-2xs">
              <label className="text-xs font-bold text-slate-800 flex items-center justify-between">
                <span>Custom Agent Instruction</span>
                <span className="text-[10px] text-slate-400 font-mono">Ctrl + Enter</span>
              </label>

              <div className="space-y-2">
                <textarea
                  rows={6}
                  placeholder="Type instructions for the multi-agent team...&#10;&#10;e.g. Focus on asymptotic complexity bounds and include a comparison table of state machine replication protocols with rigorous proofs."
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="w-full min-h-[140px] bg-[#F8FAFC] border border-slate-200 rounded-lg p-3 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-inner resize-y leading-relaxed font-sans"
                />

                <div className="flex items-center justify-between pt-0.5">
                  <span className="text-[10px] text-slate-400 italic">
                    Targets Writer, Planner & Math Agents
                  </span>
                  <button
                    disabled={isStreaming || !customPrompt.trim()}
                    onClick={handleSendPrompt}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors"
                  >
                    <Send className="w-3 h-3" />
                    <span>Run Prompt</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Live Token Streaming Buffer (only when active) */}
            {isStreaming && tokenBuffer && (
              <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 shadow-sm">
                <div className="flex items-center justify-between text-[11px] font-mono text-indigo-400 mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-indigo-400 animate-ping" />
                    <span className="font-semibold">Synthesizing Tokens...</span>
                  </div>
                  <span className="text-[10px] text-slate-400">SSE Stream</span>
                </div>
                <div className="font-mono text-xs text-slate-200 bg-slate-900 p-2.5 rounded-lg max-h-32 overflow-y-auto leading-relaxed border border-slate-800">
                  {tokenBuffer}
                  <span className="inline-block w-1.5 h-3 bg-indigo-400 ml-1 animate-pulse" />
                </div>
              </div>
            )}

            {/* Collapsible: Agent Reasoning Trace */}
            <div className="rounded-xl bg-white border border-slate-200 overflow-hidden shadow-2xs">
              <div
                onClick={() => setShowThoughts(!showThoughts)}
                className="p-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between cursor-pointer text-xs font-bold text-slate-700 hover:bg-slate-100 transition-colors"
              >
                <div className="flex items-center gap-1.5">
                  <Terminal className="w-3.5 h-3.5 text-indigo-600" />
                  <span>Agent Reasoning Trace</span>
                  <span className="text-[10px] font-mono text-slate-400 font-normal">({thoughtTrace.length} Steps)</span>
                </div>
                <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${showThoughts ? 'rotate-180' : ''}`} />
              </div>

              {showThoughts && (
                <div className="p-3 bg-slate-950 text-slate-300 font-mono text-[11px] space-y-2 max-h-48 overflow-y-auto custom-scrollbar">
                  {thoughtTrace.map((thought, idx) => (
                    <div key={idx} className="flex gap-2 items-start border-l border-indigo-500/40 pl-2">
                      <span className="text-indigo-400 font-bold select-none">[{idx + 1}]</span>
                      <span className="leading-relaxed text-slate-300">{thought}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Collapsible Drawer: Multi-Agent Execution Pipeline */}
            <div className="rounded-xl bg-white border border-slate-200 overflow-hidden shadow-2xs">
              <div
                onClick={() => setShowPipeline(!showPipeline)}
                className="p-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between cursor-pointer text-xs font-bold text-slate-700 hover:bg-slate-100 transition-colors"
              >
                <div className="flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-indigo-600" />
                  <span>Multi-Agent Execution Pipeline</span>
                  <span className="text-[10px] font-mono text-emerald-600 font-semibold bg-emerald-50 px-1.5 py-0.2 rounded border border-emerald-200">Active</span>
                </div>
                <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${showPipeline ? 'rotate-180' : ''}`} />
              </div>

              {showPipeline && (
                <div className="p-3 space-y-2 bg-[#F8FAFC]">
                  <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono pb-1 border-b border-slate-200">
                    <span>Active Team: 5 Subagents</span>
                    <span>Synchronous Bus</span>
                  </div>

                  <div className="space-y-1.5">
                    {logs.map((log) => (
                      <div
                        key={log.id}
                        className="p-2 rounded-lg bg-white border border-slate-200 flex items-center justify-between text-xs shadow-2xs"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: log.agentColor }}
                          />
                          <span className="font-semibold text-slate-800 text-[11px] truncate">
                            {log.agentName}
                          </span>
                        </div>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 flex-shrink-0">
                          {log.currentStep}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Citations Tab */}
        {activeTab === 'citations' && (
          <div className="space-y-2.5">
            <div className="p-2.5 bg-sky-50 border border-sky-100 rounded-xl text-xs text-sky-900 leading-snug">
              Ground truth source chunks matched via cosine similarity on ingested PDFs.
            </div>

            {selectedNode.ragCitations.length === 0 ? (
              <div className="p-6 text-center text-slate-400 text-xs">
                No citations referenced in this section yet. Click "Cite Sources" in Copilot.
              </div>
            ) : (
              selectedNode.ragCitations.map((cite) => (
                <div
                  key={cite.id}
                  className="p-3 rounded-xl bg-white border border-slate-200 space-y-1.5 shadow-2xs hover:border-indigo-300 transition-colors"
                >
                  <div className="flex items-center justify-between text-xs font-bold text-slate-800">
                    <span className="truncate text-indigo-700">{cite.sourceDoc}</span>
                    <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                      Score: {(cite.relevanceScore * 100).toFixed(0)}%
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-600 italic bg-slate-50 p-2 rounded-lg border border-slate-100 leading-relaxed font-serif">
                    "{cite.sectionSnippet}"
                  </p>
                  {cite.authorYear && (
                    <div className="text-[10px] text-slate-400 font-mono">
                      Ref: {cite.authorYear}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {/* Node Config Tab (Settings) */}
        {activeTab === 'tuning' && (
          <div className="space-y-3.5 p-1">
            {/* Settable Target Budget */}
            <div className="p-3 rounded-xl bg-indigo-50/50 border border-indigo-100 space-y-2">
              <label className="text-xs font-bold text-slate-800 flex items-center justify-between">
                <span>Target Page Budget</span>
                <span className="font-mono text-indigo-700 font-bold text-xs">{selectedNode.targetPages} Pages (~{selectedNode.wordBudget.toLocaleString()} words)</span>
              </label>
              
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="1"
                  max="50"
                  value={selectedNode.targetPages}
                  onChange={(e) => handleBudgetChange(parseInt(e.target.value) || 1)}
                  className="flex-1 accent-indigo-600"
                />
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={selectedNode.targetPages}
                  onChange={(e) => handleBudgetChange(parseInt(e.target.value) || 1)}
                  className="w-14 px-2 py-1 bg-white border border-slate-200 rounded-lg text-xs font-mono font-bold text-indigo-700 text-center shadow-2xs"
                />
              </div>
              <p className="text-[10.5px] text-slate-500">
                Adjusting this sets the planner's token allocation and depth expansion budget for this section.
              </p>
            </div>

            {/* Equation Density */}
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-slate-700 flex items-center justify-between">
                <span>Equation Density Level</span>
                <span className="font-mono text-indigo-600 font-bold">{selectedNode.equationDensityLevel} / 5</span>
              </label>
              <input
                type="range"
                min="1"
                max="5"
                value={selectedNode.equationDensityLevel}
                onChange={(e) => onUpdateNodeEquationDensity(parseInt(e.target.value))}
                className="w-full accent-indigo-600"
              />
              <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                <span>1 (Conceptual)</span>
                <span>3 (Standard)</span>
                <span>5 (Formal Proofs)</span>
              </div>
            </div>

            {/* Math Rigor */}
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-slate-700">
                Mathematical Rigor Level
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                {(['introductory', 'applied', 'rigorous', 'formal_proof'] as const).map((lvl) => (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => onUpdateNodeMathLevel(lvl)}
                    className={`py-1.5 px-2 rounded-lg text-xs font-semibold capitalize border transition-all ${
                      selectedNode.mathLevel === lvl
                        ? 'bg-indigo-600 text-white border-indigo-600 shadow-2xs'
                        : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {lvl.replace('_', ' ')}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer Status */}
      <div className="h-8 px-3 border-t border-slate-200 bg-[#F8FAFC] text-[11px] text-slate-500 flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <FileCheck className="w-3 h-3 text-emerald-600" />
          <span className="font-medium">Status:</span>
        </span>
        <span className="font-mono text-slate-800 capitalize font-bold text-[10px]">
          {selectedNode.status.replace('_', ' ')}
        </span>
      </div>
    </div>
  );
};
